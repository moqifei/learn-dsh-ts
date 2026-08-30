import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, GenerateRequest, GenerateResponse } from './adapter'
import type { LlmRuntime } from './llm'

/**
 * 两个演示用 Provider。它们都是"可卸载的插件"——通过 `ctx.effect` 把适配器
 * 注册进 `ctx.llm` 路由表，effect 的 disposer 负责注销。因此：
 *   卸载 Provider 的 fiber → effect 回收 → 该路由从 llm 注册表消失；
 *   但 `llm` 服务本身与其他路由照常运行。
 *
 * 这两个 Provider 都是 fake/mock（确定性输出，无需 key），但换成真实的
 * AzureAdapter / DeepSeekAdapter 时，只需把 `generate()` 内部换成 SDK 调用即可，
 * 消费者代码一行都不用改——这就是"模型是 Provider 不是运行时"的工程收益。
 */

/** Fake Provider：返回与请求相关的确定性文本（教学 smoke 用） */
class FakeAdapter implements LlmAdapter {
  constructor(private readonly label: string) {}
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const last = req.messages[req.messages.length - 1]?.content ?? ''
    const text = `FAKE(${this.label}) 对"${last}"的回复`
    return { text, finishReason: 'stop', provider: 'fake' }
  }
}

/** Echo Provider：把请求原样回声（演示"另一条路由，消费者代码不变"） */
class EchoAdapter implements LlmAdapter {
  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    const text = `[echo] system=${req.system ?? '(无)'} | last=${req.messages[req.messages.length - 1]?.content ?? ''}`
    return { text, finishReason: 'stop', provider: 'echo' }
  }
}

/** fake-provider 插件：在 llm 内注册 'fake' 路由，effect 可逆 */
export const fakeProvider = {
  name: 'fake-provider',
  inject: ['llm'],
  apply(ctx: Context) {
    console.log('[fake-provider] 插件激活')
    // effect：setup 注册路由，disposer 注销路由（卸载时自动回收）
    ctx.effect(() => {
      ;(ctx.llm as LlmRuntime).register('fake', new FakeAdapter('default'))
      return () => (ctx.llm as LlmRuntime).unregister('fake')
    }, 'fake-route')
    return () => console.log('[fake-provider] 插件卸载')
  }
}

/** echo-provider 插件：在 llm 内注册 'echo' 路由 */
export const echoProvider = {
  name: 'echo-provider',
  inject: ['llm'],
  apply(ctx: Context) {
    console.log('[echo-provider] 插件激活')
    ctx.effect(() => {
      ;(ctx.llm as LlmRuntime).register('echo', new EchoAdapter())
      return () => (ctx.llm as LlmRuntime).unregister('echo')
    }, 'echo-route')
    return () => console.log('[echo-provider] 插件卸载')
  }
}
