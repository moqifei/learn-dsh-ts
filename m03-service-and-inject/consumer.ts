import type { Context } from '@deepseek-ai/cordis'

// ============================================================================
// m03-service-and-inject — 服务消费者（consumer）
// ----------------------------------------------------------------------------
// 衔接 m01/m02：本插件的 apply(ctx) 形态与 m01 完全一致（拿到 ctx 做事），
// 但这次它"声明自己需要 greeter 这个服务"才激活。
//
// —— 从 m01 继承、未改动的部分 ——
//   - 插件仍是 apply(ctx) 入口 + 可选 name
// —— 从 m02 继承、复用 effect 的部分 ——
//   - 用 ctx.effect 注册一个清理函数，演示"依赖消失时本插件也被一起拆掉"
// —— 本课新增的部分 ——
//   - export const inject = [...]：声明依赖，Cordis 在依赖就绪前保持 PENDING
//   - apply 内直接使用 ctx.greeter，保证已就绪（无需 import 提供方）
// ============================================================================

// ---- 新增 m03：声明依赖 ——
// Cordis 会在 'greeter' 服务就绪前把本插件保持 PENDING；
// 即便本文件排在 cordis.yml 第一项，也会等到 greeter 就绪才激活。
export const name = 'greeter-consumer'
export const inject = ['greeter']

export function apply(ctx: Context) {
  // 进入这里时，ctx.greeter 保证已就绪（否则本插件一直 PENDING）
  console.log(ctx.greeter.greet('world'))

  // —— 继承自 m02 —— 演示"服务也是 effect"：
  // 注册一个 effect，依赖消失时（提供方卸载）本插件会被一起拆掉，disposer 执行。
  ctx.effect(() => {
    return () => {
      console.log('[greeter-consumer] 卸载：依赖消失时我也会被一起拆掉')
    }
  })
}
