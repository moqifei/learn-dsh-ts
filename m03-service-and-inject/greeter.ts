import { Service, type Context } from '@deepseek-ai/cordis'

// ============================================================================
// m03-service-and-inject — 服务提供者（greeter）
// ----------------------------------------------------------------------------
// 衔接 m01/m02：
//   - m01 建立了"插件 = apply(ctx) 函数 + cordis.yml 加载"的心智模型；
//   - m02 用 ctx.effect 挂了"可撤销的资源"，知道卸载即逆序清理。
// 本课把"资源"升级成命名服务（Service）：一个插件提供能力（ctx.greeter），
// 另一个插件用 inject 声明依赖来消费，且两者加载顺序无关。
//
// —— 从 m02 继承、未改动的部分 ——
//   - 插件仍是 apply(ctx) 入口 + 可选 name
//   - Service 底层就是 effect：提供方卸载时服务自动移除（m02 的"可撤销"在此复用）
// —— 本课新增的部分 ——
//   - Service 抽象类：super(ctx, name) 把实例注册到 ctx.name
//   - declare module 声明合并：让 ctx.greeter 有类型
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
export const name = 'greeter-provider'
export function apply(ctx: Context) {
  ctx.plugin(GreeterService)
  console.log('[greeter-provider] 已注册 ctx.greeter 服务')
}
