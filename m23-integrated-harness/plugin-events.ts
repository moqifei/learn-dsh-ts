/**
 * m23 · 集成快照 · 插件 `events`（事件总线聚合 / m08 事件的消费视图）
 * 注册 ctx.bus（BusService）：把分散在各服务的事件统一到一个可订阅总线，保留最近窗口用于回放。
 * 注册名用 'bus' 以避免与 cordis 内置 ctx.events（事件发射器）冲突。实现见 services.ts。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { BusService } from './services.ts'

const eventsPlugin: Plugin<Context> = {
  name: 'events',
  apply(ctx: Context) {
    ctx.plugin(BusService)
  },
}

export default eventsPlugin
