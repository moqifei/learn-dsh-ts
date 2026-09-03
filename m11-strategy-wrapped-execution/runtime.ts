/**
 * m11 · 策略包裹执行
 * ---------------------------------------------------------------------------
 * 真实工程对照：deepseek-harness `packages/core/tools` 的 `ToolRuntime`。
 *
 * 真实 `ToolRuntime.execute()` 把一次工具调用拆成三层可插拔策略瀑布：
 *
 *   1. ctx.waterfall('tools/pre-execute', exec, () => exec)
 *        —— 监听器签名 (exec, next) => exec | null。返回 null 即"拦截/短路"。
 *   2. ctx.waterfall('tools/execute', exec, () => this.dispatchToolBody(exec))
 *        —— around 钩子。next() 是"真正执行"；监听器可包裹 next 做超时/重试。
 *   3. ctx.waterfall('tools/post-execute', exec, result, () => result)
 *        —— 把结果或错误标准化。
 *
 * 课程版严格复用 cordis 4.x 的 waterfall API：
 *   - 注册策略：ctx.on('tools/pre-execute', (exec, next) => ...)
 *   - 触发管线：ctx.waterfall('tools/pre-execute', exec, () => exec)
 * 因此"执行"是一段被多方策略包裹的、可热插拔的瀑布，而非写死的函数。
 */

import { Context, Service } from '@deepseek-ai/cordis'

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  name: string
  content: unknown
  error?: { kind: string; message: string }
  interceptedBy?: string
}

export class ToolRuntime extends Service {
  static inject = [] as const
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'executor')
    void config
  }

  /** 真正执行工具（示例里没有真工具注册表，用 Math/JSON 模拟） */
  private async dispatchToolBody(call: ToolCall): Promise<unknown> {
    switch (call.name) {
      case 'add': {
        const a = Number(call.arguments.a)
        const b = Number(call.arguments.b)
        return { sum: a + b }
      }
      case 'echo': {
        const sleepMs = Number(call.arguments.__sleepMs)
        if (sleepMs > 0) {
          await new Promise((r) => setTimeout(r, sleepMs))
        }
        return { text: String(call.arguments.text) }
      }
      default:
        throw new Error(`unknown tool: ${call.name}`)
    }
  }

  /**
   * 一次工具执行 = 三层 waterfall 策略依次包裹。
   * 真实工程里这是 `ToolRuntime.execute`；课程版拎出来讲清楚"包裹"本身。
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    // ① pre-execute：策略可拦截 / 改写。没有监听器时默认放行（返回 call）。
    const passed = await this.ctx.waterfall('tools/pre-execute', call, () => call)
    if (passed === null || passed === undefined) {
      // 某条策略返回 null/undefined ⇒ 调用被拦截（短路，不真正执行）
      const by = this.lastInterceptor
      this.lastInterceptor = undefined
      const intercepted: ToolResult = {
        callId: call.id,
        name: call.name,
        content: null,
        interceptedBy: by,
      }
      this.ctx.emit('tools/result', intercepted)
      return intercepted
    }

    // ② execute：around 钩子。next() 是真正执行；策略可包裹 next 做超时/重试。
    //    默认 next（无 listener 时）直接返回"含真正执行"的 payload。
    const dispatched = (await this.ctx.waterfall(
      'tools/execute',
      { call, run: () => this.dispatchToolBody(call) },
      () => ({ call, run: () => this.dispatchToolBody(call) }),
    )) as { call: ToolCall; run: () => Promise<unknown> }

    // ③ post-execute：把结果或错误标准化为 ToolResult。
    let payload: { call: ToolCall; result?: unknown; error?: unknown } = {
      call,
    }
    try {
      payload = { ...payload, result: await dispatched.run() }
    } catch (err) {
      payload = { ...payload, error: err }
    }

    const finalized = (await this.ctx.waterfall(
      'tools/post-execute',
      payload,
      () => payload,
    )) as { call: ToolCall; result?: unknown; error?: unknown }

    const result: ToolResult = finalized.error
      ? {
          callId: call.id,
          name: call.name,
          content: null,
          error: {
            kind: (finalized.error as Error)?.name ?? 'Error',
            message: (finalized.error as Error)?.message ?? String(finalized.error),
          },
        }
      : {
          callId: call.id,
          name: call.name,
          content: finalized.result,
        }

    // 真实 `ToolRuntime` 末尾广播 `tools/result`，让记忆 / 日志 / UI 订阅
    this.ctx.emit('tools/result', result)
    return result
  }

  /** 记录上一条拦截策略名（pre-execute 里设置） */
  lastInterceptor: string | undefined

  /** 供策略设置"我被拦截了"的标记 */
  markInterceptor(name: string): void {
    this.lastInterceptor = name
  }
}

// ── 类型增强：把 runtime 服务与三段瀑布事件注入 cordis 上下文 ──────────────
declare module '@deepseek-ai/cordis' {
  interface Events {
    'tools/pre-execute': (
      call: ToolCall,
      next: () => ToolCall,
    ) => ToolCall | null | undefined
    'tools/execute': (
      payload: { call: ToolCall; run: () => Promise<unknown> },
      next: () => { call: ToolCall; run: () => Promise<unknown> },
    ) => { call: ToolCall; run: () => Promise<unknown> }
    'tools/post-execute': (
      payload: { call: ToolCall; result?: unknown; error?: unknown },
      next: () => { call: ToolCall; result?: unknown; error?: unknown },
    ) => { call: ToolCall; result?: unknown; error?: unknown }
    'tools/result': (result: ToolResult) => void
  }

  interface Context {
    executor: ToolRuntime
  }
}

export default ToolRuntime
