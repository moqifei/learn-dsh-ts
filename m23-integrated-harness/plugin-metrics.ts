/**
 * m23 · 集成快照 · 插件 `metrics`（运行期指标 / m14）
 * 注册 ctx.metrics：累计工具调用次数与模型请求数，供 observability profile 读取。
 * 实现见 services.ts 的 MetricsService（订阅统一 session 事件派生计数）。
 */
import { Context, Plugin } from '@deepseek-ai/cordis'
import { MetricsService } from './services.ts'

const metricsPlugin: Plugin<Context> = {
  name: 'metrics',
  apply(ctx: Context) {
    ctx.plugin(MetricsService)
  },
}

export default metricsPlugin
