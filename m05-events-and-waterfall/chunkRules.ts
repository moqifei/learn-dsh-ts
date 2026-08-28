import type { Context } from '@deepseek-ai/cordis'

// ============================================================================
// m05 角色文件之六：prompt chunk — rules（waterfall 内层基座）
// ----------------------------------------------------------------------------
// 参考 s06：本 listener 是"内层基座"，不调用 next()，直接返回基础文本。
// 它是整条链的终点——不调 next 即表示"接管"最终内容。
// 作为基座，应在 chunk-greeting 之后注册（Cordis waterfall 先注册者最外层）。
// ============================================================================

export const name = 'chunk-rules'
export function apply(ctx: Context) {
  ctx.on('prompt/build', (text: string) => {
    console.log('[chunk-rules] 内层基座，返回基础规则文本（不调用 next）')
    return `${text}你必须用中文回答；保持简洁。`
  })
}
