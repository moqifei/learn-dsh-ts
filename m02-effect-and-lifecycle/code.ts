import type { Context } from '@deepseek-ai/cordis'

// ============================================================================
// m02-effect-and-lifecycle — 生命周期与 effect（可撤销的资源）
// ----------------------------------------------------------------------------
// 衔接 m01：m01 我们写了一个"空的"插件——apply(ctx) 里什么都没挂，ctx 是干净的画布。
// 本课我们在 ctx 上挂第一个"有生命周期的东西"：一个资源（这里用一个定时器演示），
// 并用 ctx.effect() 告诉 Cordis "这个资源归我管，卸载我的时候请帮我收掉"。
//
// —— 从 m01 继承、未改动的部分 ——
//   - 插件仍是 `apply(ctx)` 入口 + 可选 `name`
//   - 运行时仍通过 cordis.yml 把它加载成一颗插件树
// —— 本课新增的部分 ——
//   - ctx.effect(disposer)：注册一个"在插件卸载时逆序执行"的清理函数
//   - ctx.plugin(fn)：在代码里（而非 YAML 里）再挂一个子插件，拿到它的 fiber 句柄
//   - fiber.dispose()：主动卸载一个插件，触发其所有 disposer
// ============================================================================

export const name = 'lifecycle-demo'

// 子插件：一个"心跳"，每 200ms 打印一次 tick。
// 注意：从代码挂载的插件不需要 `apply` 方法——Cordis 直接调用这个函数，
// 函数名仅用于诊断。它内部用 ctx.effect 管理自己的定时器。
function heartbeat(ctx: Context) {
  console.log('[heartbeat] 子插件加载，开始计时')
  ctx.effect(() => {
    const timer = setInterval(() => console.log('[heartbeat] tick'), 200)
    // 返回 disposer：插件卸载时 Cordis 会调用它来释放资源
    return () => {
      clearInterval(timer)
      console.log('[heartbeat] 定时器已清理（disposer 执行）')
    }
  })
}

export function apply(ctx: Context) {
  // —— 继承自 m01 —— 证明插件被激活、拿到了 ctx
  console.log('[lifecycle-demo] 主插件加载，拿到了 ctx')

  // —— 新增 m02 —— 在代码里挂载子插件，并保留它的 fiber（运行时句柄）
  const fiber = ctx.plugin(heartbeat)

  // —— 新增 m02 —— 用一个 effect 注册一个延时任务：700ms 后主动卸载子插件
  //   以此演示：插件卸载 → 它的 disposer 被逆序执行（定时器被清掉）
  ctx.effect(() => {
    const stopper = setTimeout(async () => {
      console.log('[lifecycle-demo] 700ms 到，准备卸载子插件...')
      await fiber.dispose() // 触发 heartbeat 的 disposer
      console.log('[lifecycle-demo] 子插件已卸载，退出')
      process.exit(0)
    }, 700)
    // 可选：如果这个主插件先被卸载，先取消还没执行的卸载指令
    return () => clearTimeout(stopper)
  })
}
