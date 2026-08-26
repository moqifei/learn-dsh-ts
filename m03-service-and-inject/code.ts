import { Service, type Context } from '@deepseek-ai/cordis'

// ============================================================================
// m03-service-and-inject — 单文件版（code.ts）
// ----------------------------------------------------------------------------
// 本文件把"服务提供者"和"服务消费者"都写在一个模块里，
// 作为 cordis.yml 的【唯一入口插件】。
//
// 加载机制关键（回答"为什么之前 code.ts 不生效"）：
//   - Cordis loader 只执行 cordis.yml 里列出的文件；
//   - 一个文件若导出多个 `export const name` + `export function apply`，
//     后者会覆盖前者，loader 只能识别"一个"插件入口。
//   => 所以单文件不能"平铺两个插件"，而要用【一个入口 + 内部 ctx.plugin 挂子插件】。
//
// 本课演示：
//   1) 入口插件 apply(ctx) 里用 ctx.plugin() 挂 GreeterService（provider）；
//   2) 再用 ctx.plugin() 挂 consumer（声明 inject:['greeter']），
//      因在同一 ctx 树上、provider 已就绪，consumer 立即激活；
//   3) 延时后 fiber.dispose() 卸载整棵子树，触发 provider 移除 →
//      consumer 因依赖消失一并卸载 → 其 effect 的 disposer 打印"卸载"日志。
// ============================================================================

// ---- 新增 m03：服务声明合并（仅编译期类型，无运行时开销）----
declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService
  }
}

// ---- 新增 m03：服务提供者（Service 子类，本身就是一个插件）----
export class GreeterService extends Service {
  constructor(ctx: Context) {
    // 把本实例注册到 ctx.greeter；这是 effect——提供方卸载时服务自动移除
    super(ctx, 'greeter')
  }

  greet(who: string): string {
    return `Hello, ${who}!（来自 greeter 服务）`
  }
}

// 提供方插件：挂载 GreeterService
const provider = {
  name: 'greeter-provider',
  apply(ctx: Context) {
    ctx.plugin(GreeterService)
    console.log('[greeter-provider] 已注册 ctx.greeter 服务')
  },
}

// ---- 新增 m03：服务消费者（用 inject 声明依赖）----
// 注意：写在 provider 之后由我们显式控制；即便颠倒，
// 因在同一 ctx 树上且 provider 先挂，consumer 也能就绪——加载顺序无关。
const consumer = {
  name: 'greeter-consumer',
  inject: ['greeter'],
  apply(ctx: Context) {
    // 进入这里时，ctx.greeter 保证已就绪（否则本插件一直 PENDING）
    console.log(ctx.greeter.greet('world'))

    // —— 继承自 m02 —— 演示"服务也是 effect"：
    // 注册一个 effect，等卸载时验证服务确实被收掉
    ctx.effect(() => {
      return () => {
        console.log('[greeter-consumer] 卸载：依赖消失时我也会被一起拆掉')
      }
    })
  },
}

// ---- 入口插件：本文件作为 cordis.yml 的唯一加载项 ----
// 用内部 ctx.plugin 把 provider / consumer 挂成子插件，
// 它们的生命周期由本入口插件的 ctx 托管。
// ctx.plugin(...) 会返回该子插件的 fiber（句柄），
// 调用 fiber.dispose() 即可单独卸载它（并触发其 effect 的清理函数）。
export const name = 'demo-entry'
export function apply(ctx: Context) {
  // 先挂 provider（服务就绪），再挂 consumer（依赖就绪即激活）
  const providerFiber = ctx.plugin(provider)
  const consumerFiber = ctx.plugin(consumer)

  // 演示"卸载"：2 秒后逐一 dispose 子插件，
  // 先拆 consumer（打印其 effect 的卸载日志），
  // 再拆 provider（移除 ctx.greeter 服务）。
  setTimeout(async () => {
    // 先移除 provider（ctx.greeter 服务消失），
    // Cordis 会让依赖它的 consumer 自动卸载 → 触发其 effect 的卸载日志。
    // dispose() 是异步的，必须 await，否则 process.exit 会在清理前杀掉进程。
    await providerFiber.dispose()
    await consumerFiber.dispose()
    console.log('[demo-entry] 已整体卸载，进程结束')
    process.exit(0)
  }, 2000)
}
