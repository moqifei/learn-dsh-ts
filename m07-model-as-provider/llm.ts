import { Service, Context } from '@deepseek-ai/cordis'
import type { GenerateRequest, GenerateResponse, LlmAdapter } from './adapter'

/**
 * LlmRuntime：模型能力注册表（Cordis 服务 `ctx.llm`）。
 *
 * 这是"模型是 Provider 不是运行时"的枢纽：
 *   - 它【不】持有任何模型 SDK、不发起任何 HTTP 请求；
 *   - 它只维护一个 `name → adapter` 的路由表，并负责重复名称规则与查找；
 *   - 具体模型（fake / echo / 未来的 azure / deepseek）以 Provider 插件身份，
 *     通过 `register()` 把自己的适配器挂进这张表。
 *
 * 消费者（runner / 未来的 agent loop）只调用 `complete(router, request)`，
 * 永远不 import 任何 SDK——这正是 s08「模型是提供者，不是运行时」的接缝。
 *
 * 继承 Service：提供方（本服务）卸载时，`ctx.llm` 自动移除（effect 语义复用）。
 */
export class LlmRuntime extends Service {
  private adapters = new Map<string, LlmAdapter>()

  constructor(ctx: Context) {
    super(ctx, 'llm') // 把本实例注册到 ctx.llm
  }

  /** 注册一条 Provider 路由（由 Provider 插件的 effect 调用）。重复名必须报错。 */
  register(name: string, adapter: LlmAdapter): void {
    if (this.adapters.has(name)) {
      throw new Error(`llm: provider "${name}" 已注册，重复路由被拒绝`)
    }
    this.adapters.set(name, adapter)
    console.log(`[llm] 注册路由：${name}`)
  }

  /** 注销一条 Provider 路由（Provider 插件卸载时由 effect 的 disposer 调用）。 */
  unregister(name: string): void {
    this.adapters.delete(name)
    console.log(`[llm] 移除路由：${name}`)
  }

  /** 列出当前所有路由（调试/可观测用）。 */
  list(): string[] {
    return [...this.adapters.keys()]
  }

  /**
   * 与提供者无关的一次生成。
   * @param router 路由名（如 'fake' / 'echo' / 'azure'）
   * @param req    与提供者无关的统一请求
   * @returns      与提供者无关的统一响应
   * @throws       未知路由归属于 llm 服务本身（不是消费者兜底客户端）
   */
  async complete(router: string, req: GenerateRequest): Promise<GenerateResponse> {
    const adapter = this.adapters.get(router)
    if (!adapter) {
      throw new Error(
        `llm: 未知 provider "${router}"（已注册：${this.list().join(', ') || '无'}）`
      )
    }
    return adapter.generate(req)
  }
}

// 类型合并：让 TS 认识 ctx.llm
declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmRuntime
  }
}

// 作为 loader entry：Service 子类可直接被 Cordis 加载
export default LlmRuntime
