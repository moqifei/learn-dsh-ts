/**
 * SubagentRuntime —— subagent capability seam 的 Definition 层（ctx.subagents）。
 *
 * 与 m18 的 Jobs 不同：Jobs 是"一个 kind → 一个 Producer"的单注册表；
 * subagent 是"按 name 选择 Provider"的**命名注册表**——多个 Provider 共存，
 * 调用方用名字挑一个来执行子代理。这正是 deepseek-harness 的
 * `packages/subagent/subagent/src/index.ts`（SubagentRuntime）的设计：
 * 多 Provider 并存，start(name, request) 按名分发。
 *
 * 关键：Runtime 自身**零硬编码**任何 Provider。所有能力（spawn-in-process、
 * fork、acp…）都由插件通过 registerProvider 注入——"一切皆为插件"的落点。
 */
import { Context, Service } from '@deepseek-ai/cordis'

// ── 契约类型（对应真实 types.ts 的精简版）─────────────────────────────

/** 一次 subagent 运行的请求。 */
export interface SubagentStartRequest {
  /** 展示标签。 */
  label?: string
  /** 给子代理的提示词（此处用字符串简化 ContentBlock[]）。 */
  prompt: string
  /** 调用方身份（用于 owner 式鉴权/审计，本课简化为字符串）。 */
  parent: string
  /** 可选能力：结构化输出（要求 provider 支持 outputSchema）。 */
  outputSchema?: boolean
}

/** 终态结果。 */
export interface SubagentResult {
  /** 子代理的最终输出文本。 */
  readonly output: string
  /** 为何结束。 */
  readonly stopReason: 'completed' | 'aborted' | 'error' | 'refusal'
}

/** 一次发布后的 run 句柄。 */
export interface SubagentRun {
  /** run id（本课用 parent 命名空间下的序号字符串）。 */
  readonly id: string
  /** 终态结果（resolve，不 reject 子级失败）。 */
  readonly result: Promise<SubagentResult>
  /** 取消剩余工作并释放资源，幂等。 */
  dispose(): Promise<void>
}

/** Provider 能力声明：start 时请求的能力若 provider 不支持则被拒绝。 */
export interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly persona: boolean
}

/** 一个可注册的子代理执行后端。 */
export interface SubagentProvider {
  /** 唯一注册名（如 'spawn' / 'fork' / 'acp'）。 */
  readonly name: string
  /** 支持的能力。 */
  readonly capabilities: SubagentCapabilities
  /** 是否共享父上下文（描述性，便于调试）。 */
  readonly inheritsParentContext: boolean
  /** 建立一次 one-shot 子代理，返回已发布的 run。 */
  start(request: SubagentStartRequest): Promise<SubagentRun>
}

// ── 事件合并（observer 视角）────────────────────────────────────────
declare module '@deepseek-ai/cordis' {
  interface Context {
    subagents: SubagentRuntime
  }
  interface Events {
    // 函数签名形式（不是对象类型），因为 emit<K>(name, ...args) 用 Parameters<Events[K]>
    'subagent/start': (info: { runId: string; provider: string; label?: string }) => void
    'subagent/end': (info: { runId: string; provider: string; stopReason: string }) => void
    'subagent/provider-added': (provider: SubagentProvider) => void
    'subagent/provider-removed': (name: string) => void
  }
}

/** 命名 Provider 注册表 + capability 校验的 start API。 */
export class SubagentRuntime extends Service {
  private readonly providers = new Map<string, SubagentProvider>()
  private seq = 0

  constructor(ctx: Context) {
    super(ctx, 'subagents')
  }

  /** 注册一个 Provider（effect 作用域：插件卸载 → 自动注销）。返回 disposer。 */
  registerProvider(provider: SubagentProvider): () => void {
    const name = provider.name
    if (this.providers.has(name)) {
      throw new Error(`[subagents] 已存在名为 "${name}" 的 provider`)
    }
    this.providers.set(name, provider)
    this.ctx.emit('subagent/provider-added', provider)
    // 返回 disposer；ctx.effect 会在插件卸载时调用它
    return () => {
      this.providers.delete(name)
      this.ctx.emit('subagent/provider-removed', name)
    }
  }

  /** 按名查 Provider。 */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /** 列出已注册 provider 名（插入顺序）。 */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * 在指定 Provider 上启动一次 one-shot 子代理。
   * 先做 capability 校验（缺能力即"响亮失败"，而非接受后默默忽略），再分发。
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.providers.get(name)
    if (!provider) throw new Error(`[subagents] 未知 provider="${name}"（未注册）`)
    // capability 校验：请求 outputSchema 但 provider 不支持 → 失败
    if (request.outputSchema && !provider.capabilities.outputSchema) {
      throw new Error(`[subagents] provider "${name}" 不支持 outputSchema 能力`)
    }
    const runId = `run_${++this.seq}`
    this.ctx.emit('subagent/start', { runId, provider: name, label: request.label })
    const run = await provider.start({ ...request, parent: request.parent })
    // 包装 result：结算时补发 subagent/end
    const result = run.result.then((r) => {
      this.ctx.emit('subagent/end', { runId, provider: name, stopReason: r.stopReason })
      return r
    })
    return { ...run, result }
  }
}

export default SubagentRuntime
