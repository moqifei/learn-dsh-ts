/**
 * m09 · Prompt 是多方贡献 —— 提示词注册表服务
 *
 * 一句话：**系统提示词不是一整条常量字符串，而是一组由不同插件"贡献"的、
 * 具名且有序的分段（section）；注册表在每次请求时把它们按 order 排序、插值
 * 变量、丢弃空段，组装成最终文本。**
 *
 * 对齐 deepseek-harness 真实 `packages/core/system-prompt/src/index.ts`
 * （`SystemPrompt` 服务）的核心不变量：
 *   1. **具名分段**：`section(name, order, text)`，重名注册抛错（归属清晰）；
 *   2. **注册即 effect**：`section()` 返回 Cordis effect 清理函数，插件卸载时
 *      该分段自动消失（HMR 安全）；
 *   3. **动态 provider**：`text` 可以是函数，组装时求值（每次请求重新解析）；
 *   4. **严格变量**：`{{name}}` 必须已注册，未知/未解析值直接抛错（不在模型
 *      提示词里留下 `{{missing}}`）；
 *   5. **确定性排序**：按 `(order, name)` 排序——挂载顺序不决定渲染顺序；
 *   6. **先组装再请求**：真实实现里 `system = assemble()` 后写入
 *      `request/header` 事件再发模型调用；本课打印渲染结果模拟这一步。
 *
 * 本课用最小可运行模型讲清这 6 条，未引入真实实现的 scoped layer / waterfall
 * / tool-schema / runtime-context（这些在 README 的"真实工程实践"小节对照）。
 */

import { Context, Service } from '@deepseek-ai/cordis'

// 让本示例能用 'system-prompt/change' 事件（贴近真实实现的卸载副作用）。
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 任意段/变量注册或撤销时触发，通知下游"提示词变了，需重新组装"。 */
    'system-prompt/change'(): void
  }
}

/** 变量名：与真实实现一致，仅小写字母开头 + 字母数字下划线。 */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
/** 一个完整 `{{name}}` 引用组。 */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

/** 一段提示词贡献。 */
export interface PromptSection {
  /** 唯一名字——重名注册抛错。 */
  readonly name: string
  /** 升序拼接；约定 -100 是 harness 身份，0 是部署人格，100-199 是工具指导。 */
  readonly order: number
  /** 静态文本，或组装时求值的 provider（可引用 `{{变量}}`）。 */
  readonly text: string | ((context: AssembleContext) => string)
}

/** 一次组装的上下文（本课极简；真实实现带 scope / signal）。 */
export interface AssembleContext {
  /** 用于动态 provider 的可选上下文数据。 */
  readonly meta?: Record<string, unknown>
}

/** 组装结果（与真实 PromptAssembly 同构，但只取 sections + variables）。 */
export interface PromptAssembly {
  sections: { name: string; text: string }[]
  variables: Record<string, string | undefined>
}

/** 提示词注册表服务（挂在 ctx.prompt）。 */
export class PromptRegistry extends Service {
  /** 分段按 name 索引（重名检测用），文本在 assemble 时再按 order 排序。 */
  private readonly sections = new Map<string, PromptSection>()
  /** 变量 provider 按 name 索引。 */
  private readonly variables = new Map<string, (ctx: AssembleContext) => string | undefined>()

  constructor(ctx: Context) {
    super(ctx, 'prompt')
  }

  /**
   * 注册一段提示词贡献。注册即 effect：返回的 disposer 调用后该分段消失。
   * @param section - 具名有序分段。
   * @returns Cordis effect 清理函数（卸载插件时自动调用）。
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order 必须是有限数`)
    }
    if (this.sections.has(section.name)) {
      throw new Error(`prompt section "${section.name}" 已注册（重复贡献直接拒绝）`)
    }
    this.sections.set(section.name, section)
    this.ctx.emit('system-prompt/change')
    // 返回 disposer：真实实现里由 ctx.effect 在插件卸载时自动调用，
    // 调用即撤销该段并再次 emit 通知下游。
    return () => {
      this.sections.delete(section.name)
      this.ctx.emit('system-prompt/change')
    }
  }

  /**
   * 注册一个严格变量。组装时求值；未知变量或解析为 undefined 的变量会让
   * 渲染失败（不在模型提示词里留下 `{{missing}}`）。
   * @returns effect 清理函数。
   */
  variable(name: string, provider: (ctx: AssembleContext) => string | undefined): () => void {
    if (!VARIABLE_NAME.test(name)) {
      throw new Error(`非法变量名 "${name}"（必须匹配 ${String(VARIABLE_NAME)}）`)
    }
    if (this.variables.has(name)) {
      throw new Error(`prompt variable "${name}" 已注册（重复变量直接拒绝）`)
    }
    this.variables.set(name, provider)
    return () => {
      this.variables.delete(name)
    }
  }

  /**
   * 组装：解析变量 → 收集所有分段并按 (order, name) 排序 → 严格插值 → 丢弃空段。
   * @param context - 本次组装上下文（传给动态 provider）。
   * @returns 组装结果（sections 已排序、变量已解析）。
   */
  async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
    // 1. 解析变量（顺序无关，先全解析）。
    const resolved: Record<string, string | undefined> = {}
    for (const [name, provider] of this.variables) {
      resolved[name] = provider(context)
    }

    // 2. 收集分段、按 (order, name) 确定性排序（挂载顺序不影响结果）。
    const ordered = [...this.sections.values()]
      .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(s => ({
        name: s.name,
        text: typeof s.text === 'function' ? s.text(context) : s.text,
      }))

    return { sections: ordered, variables: resolved }
  }

  /** 渲染：严格插值 + 丢弃空段 + 空行拼接。 */
  render(assembly: PromptAssembly): string {
    return assembly.sections
      .map(s => ({ name: s.name, text: this.interpolate(s, assembly.variables) }))
      .filter(s => s.text.length > 0)
      .map(s => s.text)
      .join('\n\n')
  }

  /** 严格插值：未知/未定义/格式错误直接抛错；替换后的值不再二次扫描。 */
  private interpolate(
    input: { name: string; text: string },
    variables: Record<string, string | undefined>,
  ): string {
    const text = input.text
    let result = ''
    let last = 0
    for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
      const group = GROUP_AT.exec(text.slice(open))
      if (group === null) {
        // 后续没有 `}}` 则视为字面散文；有 `}}` 则视为格式错误。
        if (text.indexOf('}}', open + 2) >= 0) {
          throw new Error(`格式错误的变量引用 at "${text.slice(open, open + 16)}…" in section "${input.name}"`)
        }
        result += text.slice(last, open + 2)
        last = open + 2
        continue
      }
      const name = group[0].slice(2, -2)
      if (!VARIABLE_NAME.test(name)) {
        throw new Error(`格式错误的变量引用 "{{${name}}}" in section "${input.name}"`)
      }
      if (!Object.hasOwn(variables, name)) {
        const known = Object.keys(variables)
        throw new Error(`未知变量 "{{${name}}}" in section "${input.name}"；已注册：${known.join(', ') || '(none)'}`)
      }
      const value = variables[name]
      if (value === undefined) {
        throw new Error(`变量 "{{${name}}}" 本次无值（section "${input.name}"）`)
      }
      result += text.slice(last, open) + value
      last = open + group[0].length
    }
    return result + text.slice(last)
  }
}

export default PromptRegistry

// 让 ctx.prompt 可用
declare module '@deepseek-ai/cordis' {
  interface Context {
    prompt: PromptRegistry
  }
}
