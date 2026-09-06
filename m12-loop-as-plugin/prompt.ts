/**
 * m12 · Loop 也是插件 · 能力服务（二）：Prompt
 * ---------------------------------------------------------------------------
 * 真实工程对照：deepseek-harness `packages/core/system-prompt` 的 PromptRegistry。
 * 课程版简化为一个可 render 的服务（不展开"多方贡献"细节，m09 已专门讲过）。
 * Loop 通过 `ctx.require('prompt').render()` 拿到 system prompt——它不关心
 * 这段 prompt 是怎么被各贡献方拼出来的。
 */

import { Context, Service } from '@deepseek-ai/cordis'

export class PromptService extends Service {
  static inject = [] as const
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'prompt')
    void config
  }

  render(): string {
    return (
      'You are a coding agent. Use the provided tools to complete the task. ' +
      'Act instead of only explaining.'
    )
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    prompt: PromptService
  }
}

export default PromptService
