import type { Context } from '@deepseek-ai/cordis'

// ============================================================================
// m04 角色文件之三：末端 consumer —— 要求 a、b，打印整条链
// ----------------------------------------------------------------------------
// 独立插件，由 cordis.yml 加载。声明 inject:['a','b']，是依赖链末端。
// 设计要点：C 是"纯消费者"，不再注册成 Service（不提供新能力，只观察链路），
// 避免"刚注册 c 紧接着 ctx.c 不可用"的时序问题。
// ============================================================================

export const name = 'consumer-c'
export const inject = ['a', 'b']

export function apply(ctx: Context) {
  console.log(`[C] 链路打通：a=${ctx.a.whoami()} → b=${ctx.b.whoami()} → c=ok`)
}
