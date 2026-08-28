import type { Context } from '@deepseek-ai/cordis'

// ============================================================================
// m05 角色文件之五：prompt chunk — greeting（waterfall 外层包装）
// ----------------------------------------------------------------------------
// 参考 s06：本 listener 是"外层"，收到 (text, next)，调用 next(...) 把控制交给下游，
// 并在下游结果外面包一层问候语。不调用 next 就直接 return 才是"接管/否决"。
// 注意：waterfall 中先注册的 listener 在最外层，因此本文件应在 chunk-rules 之前注册。
// ============================================================================

export const name = 'chunk-greeting'
export function apply(ctx: Context) {
  ctx.on('prompt/build', (text: string, next: (t: string) => string) => {
    const built = next(text) // 交给内层（基座）继续组装其它部分
    console.log('[chunk-greeting] 外层包装，在内层结果前加问候语')
    return `【系统】${built} 你好，我是 AI 助手。`
  })
}
