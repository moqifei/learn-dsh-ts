import type { Context } from '@deepseek-ai/cordis'

// ============================================================================
// m05 角色文件之七：prompt ready observer（事件消费者）
// ----------------------------------------------------------------------------
// 监听 prompt/ready，打印最终组装完成的系统提示词。与 prompt 服务无依赖关系。
// ============================================================================

export const name = 'prompt-watcher'
export function apply(ctx: Context) {
  ctx.on('prompt/ready', (text: string) => {
    console.log(`[prompt-watcher] 系统提示词组装完成：\n  ${text}\n`)
  })
}
