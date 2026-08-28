import { Service, type Context } from '@deepseek-ai/cordis'

// ============================================================================
// m05 角色文件之一：stats 服务（事件的生产者）
// ----------------------------------------------------------------------------
// 参考 s05：服务适合"直接能力调用"（返回结果），而"已提交的事实"用事件广播。
// 这里 Stats 持有计数器，每次 bump 后 emit('stats/report', name, count)，
// 把"计数已变更"这个事实广播给所有独立 observer，且不关心谁在监听。
// ============================================================================

declare module '@deepseek-ai/cordis' {
  interface Context {
    stats: StatsService
  }
  // —— 新增 m05 —— 事件词汇表：stats 子系统拥有 'stats/report' 这个事实广播
  interface Events {
    'stats/report'(name: string, count: number): void
  }
}

export class StatsService extends Service {
  private counts: Record<string, number> = {}

  constructor(ctx: Context) {
    super(ctx, 'stats')
  }

  // —— 继承自 m03 —— Service 方法；返回权威结果（能力调用）
  bump(name: string): number {
    const count = (this.counts[name] ?? 0) + 1
    this.counts[name] = count
    // —— 新增 m05 —— 状态先提交，再广播"已提交的事实"
    this.ctx.emit('stats/report', name, count)
    return count
  }
}

export const name = 'stats-provider'
export function apply(ctx: Context) {
  ctx.plugin(StatsService)
}
