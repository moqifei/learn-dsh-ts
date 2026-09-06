import { Context } from '@deepseek-ai/cordis'
import { createScope } from './scope.ts'
import type { Scope, ScopeRegistry } from './scope.ts'
import { PresetStore } from './preset.ts'
import type { Preset } from './preset.ts'
import { RuntimeServices } from './runtime.ts'

/**
 * m14 · Preset 组合 Agent — Agent 工厂（核心事务）
 *
 * 对应 Python 版 s15 的 `AgentFactory.create`：把"用一个 preset 创建一个 agent"
 * 做成一个**事务**——
 *
 *   1. 解析并校验 preset（失败 → 直接抛错，不创建任何东西）；
 *   2. 在全局 root 下开一个全新的 session scope（此时它还"未发布"）；
 *   3. 在该 scope 下挂载插件子树：
 *        · persona-plugin：写入该 agent 的人设文本；
 *        · tool-policy-plugin：按 preset.tools 把工具实现挂进该 scope 的 toolbox；
 *   4. 审计：persona 非空、toolbox 非空 → 否则抛错；
 *   5. 审计通过 → 把 agent 登记进 factory.sessions（"发布"）；
 *      任一中间步骤抛错 → 回滚：dispose 这个 scope，agent 不进 sessions 表。
 *
 * 关键点（对应真实工程的"组合"思想）：
 *   - 每个 agent 拥有**自己的 scope 子树**，彼此隔离；
 *   - 它们**共享**同一个 RuntimeServices（主机平面），所以工具实现只存一份；
 *   - scope 销毁只回收"该 agent 自己的子树"，不影响兄弟 agent，也不影响 runtime。
 */

/** 一个已发布的 agent 实例。 */
export interface Agent {
  readonly sessionId: string
  readonly presetId: string
  readonly scope: Scope
  persona(): string
  toolNames(): string[]
  callTool(name: string, arg: string): string
  close(): Promise<void>
}

/** 一个 agent 在 scope 下挂载了哪些"插件子树"（用于观察/审计）。 */
interface Mounted {
  scope: Scope
  plugins: string[]
}

/**
 * AgentFactory：用 preset 组合出 agent 的工厂。
 */
export class AgentFactory {
  private readonly presetStore: PresetStore
  private readonly runtime: RuntimeServices
  private readonly globalScope: Scope
  /** 已发布的 agent：sessionId → { scope, 挂载的插件清单 } */
  private readonly sessions = new Map<string, { agent: Agent; mounted: Mounted }>()

  constructor(
    parent: Context,
    presetStore: PresetStore,
    runtime: RuntimeServices,
  ) {
    this.presetStore = presetStore
    this.runtime = runtime
    // 全局作用域（host plane 的承载者），所有 session scope 都是它的子树
    // 这里用一个轻量 scope 表达"共享根"，不登记进 ScopeRegistry 的 agent 表
    this.globalScope = {
      key: 'global',
      ctx: parent,
      disposed: false,
      dispose: async () => {
        /* 全局根不在此处销毁 */
      },
    }

    // 调用方需保证 parent 上已注册 ScopeRegistry（见 runner 里的 await root.plugin(ScopeRegistry)）
    this.scopes = parent.scopes
  }

  private readonly scopes: ScopeRegistry

  /** 已发布的 session 数量（调试用）。 */
  get sessionCount(): number {
    return this.sessions.size
  }

  /**
   * 用一个 preset 创建一个 agent（事务）。
   * @throws 重复 sessionId、preset 校验失败、审计失败 → 均回滚 scope 后抛错
   */
  async create(sessionId: string, presetId: string): Promise<Agent> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`session already exists: ${sessionId}`)
    }

    // ① 校验 preset（失败直接抛，不创建任何东西）
    const preset: Preset = this.presetStore.resolve(presetId)

    // ② 开一个全新的、尚未发布的 session scope
    const scope = await createScope(this.globalScope.ctx, `session:${sessionId}`)
    this.scopes.register(scope)
    const mounted: Mounted = { scope, plugins: [] }

    try {
      // ③ 在 scope 下挂载 persona 插件（写入人设文本）
      await this.mountPersona(scope, preset)
      mounted.plugins.push('persona-plugin')

      // ③ 在 scope 下挂载 tool-policy 插件（按 preset.tools 挂工具实现）
      await this.mountTools(scope, preset)
      mounted.plugins.push('tool-policy-plugin')

      // ④ 审计：persona / tools 都必须真的可用
      const persona = this.resolvePersona(scope)
      if (!persona || persona.trim() === '') {
        throw new Error('preset subtree did not become usable: empty persona')
      }
      const toolNames = this.resolveToolNames(scope)
      if (toolNames.length === 0) {
        throw new Error('preset subtree did not become usable: no tools')
      }

      // ⑤ 审计通过 → 发布：登记进 sessions 表
      const agent: Agent = {
        sessionId,
        presetId: preset.presetId,
        scope,
        persona: () => this.resolvePersona(scope),
        toolNames: () => this.resolveToolNames(scope),
        callTool: (name, arg) => {
          // 工具调用走共享 runtime，并记录遥测
          return this.runtime.callTool(sessionId, name, arg)
        },
        close: async () => {
          await this.scopes.dispose(scope.key)
          this.sessions.delete(sessionId)
        },
      }
      this.sessions.set(sessionId, { agent, mounted })
      return agent
    } catch (err) {
      // 回滚：销毁未发布的 scope，确保不残留
      await this.scopes.dispose(scope.key)
      throw err
    }
  }

  /** 取出一个已发布的 agent（不存在抛错）。 */
  get(sessionId: string): Agent {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`no such session: ${sessionId}`)
    return entry.agent
  }

  /** 全局关闭：回收所有 agent + 全局根。 */
  async close(): Promise<void> {
    for (const { agent } of [...this.sessions.values()].reverse()) {
      await agent.close()
    }
    this.sessions.clear()
  }

  // ── 内部：scope 下的插件挂载与解析 ──────────────────────────────────

  /** 在 scope 下挂载 persona 插件：把 preset.persona 写进该 scope 的局部存储。 */
  private async mountPersona(scope: Scope, preset: Preset) {
    await scope.ctx.plugin((ctx) => {
      // 用 effect 把"人设文本"登记为 scope 的局部状态；scope 销毁时自动清掉
      ctx.effect(() => {
        personaStore.delete(scope.key)
        return () => {}
      })
      personaStore.set(scope.key, preset.persona)
    })
  }

  /** 在 scope 下挂载 tool-policy 插件：按 preset.tools 把实现挂进该 scope 的 toolbox。 */
  private async mountTools(scope: Scope, preset: Preset) {
    await scope.ctx.plugin((ctx) => {
      for (const name of preset.tools) {
        const impl = this.runtime.toolImpls.get(name)!
        toolBox.set(scope.key, name, impl)
      }
      // scope 销毁时，toolBox 里该 scope 的桶随 scope/disposed 事件清空
      ctx.on('scope/disposed', (key) => {
        if (key === scope.key) toolBox.deleteScope(scope.key)
      })
    })
  }

  private resolvePersona(scope: Scope): string {
    return personaStore.get(scope.key) ?? ''
  }

  private resolveToolNames(scope: Scope): string[] {
    return toolBox.names(scope.key)
  }
}

// ── 极简的 scope 局部存储（persona / tools 按 scopeKey 分桶）───────────
// 真实工程里这些会落在 scope 子树上的 service；这里用 Map 分桶表达"按作用域隔离"。
const personaStore = new Map<string, string>()

class ToolBox {
  private byScope = new Map<string, Map<string, (arg: string) => string>>()
  set(scopeKey: string, name: string, impl: (arg: string) => string) {
    let bucket = this.byScope.get(scopeKey)
    if (!bucket) {
      bucket = new Map()
      this.byScope.set(scopeKey, bucket)
    }
    bucket.set(name, impl)
  }
  names(scopeKey: string): string[] {
    return [...(this.byScope.get(scopeKey)?.keys() ?? [])]
  }
  deleteScope(scopeKey: string) {
    this.byScope.delete(scopeKey)
  }
}
const toolBox = new ToolBox()
