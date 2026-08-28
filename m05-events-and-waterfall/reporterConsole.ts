import type { Context } from '@deepseek-ai/cordis'

// ============================================================================
// m05 角色文件之二：console observer（事件的消费者之一）
// ----------------------------------------------------------------------------
// 只注册一个监听器，打印 stats/report。它不 import stats，也不成为 stats 的依赖。
// 移除本插件后，Stats.bump 仍正常工作——这正是"观察"与"依赖"解耦。
// ============================================================================

export const name = 'reporter-console'
export function apply(ctx: Context) {
  // —— 新增 m05 —— on 返回的 disposer 随本 fiber 自动卸载（无需手动清理）
  ctx.on('stats/report', (name: string, count: number) => {
    console.log(`[console-observer] ${name} -> ${count}`)
  })
}
