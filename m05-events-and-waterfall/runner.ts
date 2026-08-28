import type { Context } from '@deepseek-ai/cordis'

// ============================================================================
// m05 入口：触发事件与 waterfall，演示"观察解耦 + 包装语义"
// ----------------------------------------------------------------------------
// 本文件不提供任何服务，只负责在运行时调动前面各角色的协作：
//   1) 调用 ctx.stats.bump 几次 —— 触发 stats/report 事件（多个 observer 独立收到）
//   2) 调用 ctx.prompt.build —— 触发 prompt/build waterfall（多层包装）
//   3) 演示"卸载一个 observer 后，emit 仍工作"
// ============================================================================

export const name = 'runner'
export const inject = ['stats', 'prompt'] // 运行驱动需要这两个服务
export async function apply(ctx: Context) {
  // —— 事件演示 ——
  console.log('--- 事件：stats/report 广播给独立 observer ---')
  ctx.stats.bump('tool_call')
  ctx.stats.bump('tool_call')
  ctx.stats.bump('prompt')

  // —— waterfall 演示 ——
  console.log('\n--- waterfall：prompt/build 多层包装 ---')
  // 必须 await！build() 是 async，内部 `await this.ctx.waterfall(...)` 会挂起，
  // 把 emit('prompt/ready') 推迟到 microtask；若漏掉 await，下面的 temp-observer
  // 同步代码会先跑完，导致 [prompt-watcher] 日志排到 temp 三行之后（看似乱序）。
  await ctx.prompt.build()

  // —— 演示"卸载一个 observer 后，事件仍工作"（观察与依赖解耦）——
  // 运行时动态注册一个临时 observer，保存其 disposer
  const tempOff = ctx.on('stats/report', (name: string, count: number) => {
    console.log(`[temp-observer] 我会随 disposer 消失：${name} -> ${count}`)
  })
  ctx.stats.bump('temp_test') // 三个 observer 都收到（含 temp）

  setTimeout(() => {
    tempOff() // 只卸载 temp-observer，不影响 console/log observer
    console.log('\n[runner] 已卸载 temp-observer，再 bump 一次：')
    ctx.stats.bump('tool_call') // 只剩 console/log observer 收到
  }, 150)

  setTimeout(() => {
    console.log('\n[runner] 进程结束，退出')
    process.exit(0)
  }, 500)
}
