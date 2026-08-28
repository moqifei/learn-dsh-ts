import { Service, type Context } from '@deepseek-ai/cordis'

// ============================================================================
// m05 角色文件之四：prompt 服务（waterfall 的生产者）
// ----------------------------------------------------------------------------
// 参考 s06：有些扩展点不是"观察"，而是"包装/转换/否决"。
// 系统提示词组装正是一个 waterfall：每个 chunk listener 收到 (text, next)，
// 调用 next(newText) 把控制交给下游，不调用 next 而直接返回则接管（veto/基座）。
// 组装完成后用事件 prompt/ready 广播最终结果。
// ============================================================================

declare module '@deepseek-ai/cordis' {
  interface Context {
    prompt: PromptService
  }
  // —— 新增 m05 —— 事件词汇表：prompt 子系统拥有两个事件
  interface Events {
    // waterfall：每个 chunk listener 收到 (text, next)，next 是向下游的 continuation
    'prompt/build'(text: string, next: (t: string) => string): string
    // 组装完成是已提交事实，广播给 observer
    'prompt/ready'(text: string): void
  }
}

export class PromptService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'prompt')
  }

  // 收集所有 chunk listener 的包装结果，返回最终系统提示词
  async build(): Promise<string> {
    // waterfall 的最后一个参数是最内层"基座 continuation"：
    // 它不调用外层 next，直接返回初始文本，作为整条链的终点。
    const text = await this.ctx.waterfall(
      'prompt/build',
      '' as string,
      (base: string) => base,
    )
    // —— 新增 m05 —— 组装完成是"已提交事实"，广播给 observer
    this.ctx.emit('prompt/ready', text)
    return text
  }
}

export const name = 'prompt-provider'
export function apply(ctx: Context) {
  ctx.plugin(PromptService)
}
