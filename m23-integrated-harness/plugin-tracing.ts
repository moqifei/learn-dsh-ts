/**
 * m23 · 集成快照 · 插件 `tracing`（调用链追踪 / m13）
 * 注册 ctx.tracing：为一次 agent run 建立 trace，自动记录每段（model / tool / subagent）。
 * 实现见 services.ts 的 TracingService（订阅统一 session 事件派生 span）。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { TracingService } from './services.ts'

const tracingPlugin: Plugin<Context> = {
  name: 'tracing',
  apply(ctx: Context) {
    ctx.plugin(TracingService)
  },
}

export default tracingPlugin
