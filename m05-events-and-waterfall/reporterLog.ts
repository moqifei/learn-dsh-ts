import type { Context } from '@deepseek-ai/cordis'

// ============================================================================
// m05 角色文件之三：log observer（事件的另一个消费者）
// ----------------------------------------------------------------------------
// 第二个独立 observer：把每次报告收集到数组里。
// 关键：添加/移除观察者都不需要修改 Stats 或 reporter-console 源码——
// 这就是"生产者只命名事实，不知道观察者"。
// ============================================================================

export const name = 'reporter-log'
export function apply(ctx: Context) {
  const log: string[] = []
  ctx.on('stats/report', (name: string, count: number) => {
    log.push(`${name}:${count}`)
    console.log(`[log-observer] 已记录，当前历史=${JSON.stringify(log)}`)
  })
}
