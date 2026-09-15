/**
 * m22 · 外部能力接入（定义 + 消费者）
 *
 * 设计要点（对齐 deepseek-harness s23 的 Definition/Provider/Consumer 拆分）：
 * - 外部能力（MCP / Web / LSP）不是一个特殊子系统，而是"对 ctx.tools 贡献工具"的
 *   一种 Provider 插件。Provider 之间的唯一区别是挂载时拥有的副作用类型：
 *     - core  Provider：拥有进程内函数（无连接）
 *     - mcp   Provider：拥有一个子进程 / socket 连接
 *     - web   Provider：拥有一个 HTTP 服务器连接
 *     - lsp   Provider：拥有一个 JSON-RPC 子进程连接
 * - 本文件只定义"能力是什么"（Definition）与"能力如何被消费者统一享用"
 *   （Consumer：ctx.external），不关心具体能力怎么连。这就是 s23 的
 *   "Definition 与 Provider/Consumer 的一刀切分离"。
 *
 * 一切皆为插件的核心证据：external CapabilityRuntime 把每个 Provider 贡献的工具
 * 挂载进 SAME ctx.tools 树；Agent Loop 只调用 ctx.tools.schemas()/execute(name)，
 * 从不分支"这个工具是 core 还是 mcp/web/lsp"。
 */

import { Context, Service, Plugin } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRegistry
    external: CapabilityRuntime
  }
}

// ───────────────────────────── 定义（Definition） ─────────────────────────────

/** 一个被挂载进工具树的工具（来自任意 Provider，core 或 external 无区别）。 */
export interface MountedTool {
  /** 注册表可见名，形如 `cap__<provider>__<localName>`。 */
  name: string
  description: string
  parameters: Record<string, unknown>
  /** 实际执行函数；core 工具是进程内闭包，external 工具是转发到连接。 */
  execute: (args: unknown) => unknown | Promise<unknown>
}

/**
 * 外部能力 Provider 的定义。任何"连接型能力"都实现这三个方法：
 * - namespace：本 Provider 贡献的工具前缀（命名空间隔离，避免冲突）
 * - listTools：发现并列出本 Provider 当前可用的工具（连接失败应抛错，由调用方转译）
 * - close：撤销连接副作用（与 s02 的"挂载即 effect，卸载即撤销"一致）
 */
export interface ExternalCapabilityProvider {
  readonly namespace: string
  listTools(): Promise<MountedTool[]> | MountedTool[]
  close(): void | Promise<void>
}

/** 暴露给 cordis 的配置类型：Provider 插件用它构造实例。 */
export interface ExternalConfig {
  server?: { name?: string }
  web?: { baseUrl?: string; path?: string }
  lsp?: { command?: string; args?: string[] }
}

// ───────────────────────────── 工具树（支撑，复用 s11/m10 模式） ─────────────────────────────

/**
 * 极简工具注册表（与 m10 同形：register 即 effect、schemas 投影、execute 按名分发）。
 * 本课焦点是"外部能力如何作为插件进入同一棵树"，故工具树保持最小实现。
 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: unknown) => unknown | Promise<unknown>
}

export class ToolRegistry extends Service {
  static readonly methods = ['register', 'schemas', 'execute']
  private readonly map = new Map<string, ToolDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(def: ToolDefinition): () => void {
    if (this.map.has(def.name)) throw new Error(`tool "${def.name}" already registered`)
    this.map.set(def.name, def)
    return () => {
      this.map.delete(def.name)
    }
  }

  schemas(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return [...this.map.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
  }

  async execute(name: string, args: unknown): Promise<unknown> {
    const def = this.map.get(name)
    if (def === undefined) throw new Error(`unknown tool "${name}"`)
    return def.execute(args)
  }
}

// ───────────────────────────── 消费者（Consumer） ─────────────────────────────

/**
 * CapabilityRuntime：外部能力的消费者侧。
 * - 持有**具名 Provider 注册表**（与"子代理注册表 / 工作流注册表"同一模式：能力按名登记）；
 * - 把每个 Provider 贡献的工具挂载进 ctx.tools（复用 s11/m10 的工具树）；
 * - 对 Agent Loop 暴露 schemas()/execute()，与 core 工具无差别消费。
 */
export class CapabilityRuntime extends Service {
  static readonly methods = ['registerProvider', 'unregisterProvider', 'schemas', 'execute', 'namespaces']

  /** 具名 Provider 注册表：name -> provider（与子代理注册表同一形态）。 */
  private readonly registry = new Map<string, ExternalCapabilityProvider>()
  /** 当前挂载到 ctx.tools 的工具 disposer：toolName -> 撤销函数。 */
  private readonly disposers = new Map<string, () => void>()

  constructor(ctx: Context, config: ExternalConfig) {
    super(ctx, 'external')
  }

  /** 注册一个 Provider（由 Provider 插件在 ctx.effect 中调用 —— 注册即 effect）。 */
  registerProvider(name: string, provider: ExternalCapabilityProvider): void {
    if (this.registry.has(name)) throw new Error(`capability provider "${name}" already registered`)
    this.registry.set(name, provider)
    this.ctx.logger.info(`[capability] register provider: ${name}`)
    this.ctx.effect(() => {
      // 挂载即 effect：Provider 插件卸载 → 自动撤下它贡献的所有工具。
      // listTools 可能同步返回数组，也可能异步（连接型能力），统一用 Promise.resolve 收口。
      Promise.resolve(provider.listTools()).then(tools => this.mountTools(provider.namespace, tools))
      return () => this.unmountProvider(name)
    })
  }

  unregisterProvider(name: string): void {
    this.unmountProvider(name)
    this.registry.delete(name)
  }

  private unmountProvider(name: string): void {
    for (const [toolName, dispose] of [...this.disposers]) {
      if (toolName.startsWith(`cap__${name}__`)) {
        dispose()
        this.disposers.delete(toolName)
      }
    }
  }

  /** 把 Provider 发现的工具挂载进 ctx.tools（与 core 工具同一条树）。 */
  private mountTools(providerNs: string, tools: MountedTool[]): void {
    const toolsSvc = this.ctx.get('tools')
    if (toolsSvc === undefined) {
      this.ctx.logger.warn('[capability] ctx.tools 未挂载，跳过工具挂载')
      return
    }
    for (const t of tools) {
      const fullName = `cap__${providerNs}__${t.name}`
      const dispose = toolsSvc.register({
        name: fullName,
        description: t.description,
        parameters: t.parameters,
        execute: t.execute,
      })
      this.disposers.set(fullName, dispose)
      this.ctx.logger.info(`[capability] mounted tool: ${fullName}`)
    }
    // 工具变化 → 通知下游（与 s11 的 tools/change 同源语义）。
    this.ctx.emit('tools/change', this.namespaces())
  }

  /** 当前已注册 Provider 的命名空间列表。 */
  namespaces(): string[] {
    return [...this.registry.keys()]
  }

  /** 投影给模型看的工具菜单（不含 execute 实现）。 */
  schemas(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    const toolsSvc = this.ctx.get('tools')
    if (toolsSvc === undefined) return []
    return toolsSvc.schemas().filter(s => s.name.startsWith('cap__'))
  }

  /** 按 name 分发执行（Agent Loop 只传 name+args，不关心谁实现）。 */
  async execute(name: string, args: unknown): Promise<unknown> {
    const toolsSvc = this.ctx.get('tools')
    if (toolsSvc === undefined) throw new Error(`unknown capability tool "${name}"`)
    return toolsSvc.execute(name, args)
  }
}

// ───────────────────────────── 装配入口（两个 Service 一起注册） ─────────────────────────────

/**
 * 默认导出插件：把 ToolRegistry（ctx.tools）与 CapabilityRuntime（ctx.external）
 * 一并注册进同一个 ctx。两个都是 Service，注册即 effect，卸载即撤销。
 */
const externalSetup: Plugin<Context, ExternalConfig> = (ctx, config) => {
  ctx.plugin(ToolRegistry)
  ctx.plugin(CapabilityRuntime, config)
}

export default externalSetup
