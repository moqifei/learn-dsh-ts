import { Service, type Context } from '@deepseek-ai/cordis'

// ============================================================================
// m04 角色文件之二：链中 provider —— 要求 a，提供 ctx.b
// ----------------------------------------------------------------------------
// 独立插件，由 cordis.yml 加载。声明 inject:['a']，因此即便它比 A 先加载，
// 也会在 a 就绪前保持 PENDING，a 一到立即激活。
// ============================================================================

// —— 新增 m04 —— 声明 b 的服务类型 ——
declare module '@deepseek-ai/cordis' {
  interface Context {
    b: ServiceB
  }
}

// —— 新增 m04 —— 链中 provider：要求 a，提供 b ——
export class ServiceB extends Service {
  constructor(ctx: Context) {
    super(ctx, 'b')
  }
  whoami() {
    return 'B'
  }
}

export const name = 'provider-b'
export const inject = ['a'] // 模块级导出：声明本插件需要服务 a
export function apply(ctx: Context) {
  // 挂载 ServiceB（提供 b）。a 未就绪时本插件 PENDING，apply 暂不执行。
  ctx.plugin(ServiceB)
  console.log('[B] 已注册 ctx.b 服务（依赖 ctx.a 已就绪）')
}
