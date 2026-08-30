import { Context } from '@deepseek-ai/cordis'
import { GenerateRequest } from './adapter'
import { fakeProvider, echoProvider } from './providers'

export const name = 'runner'
export const inject = ['llm'] // 消费者只依赖 llm 能力服务，不依赖任何具体模型
export async function apply(ctx: Context) {
  console.log('=== m07：模型是 Provider 不是运行时 ===')

  // 用 root context 挂载两个 Provider 插件（平铺到 root，避免嵌套触发重启）
  const root = (ctx as any).root ?? ctx
  const fakeFiber = root.plugin(fakeProvider)
  await fakeFiber
  const echoFiber = root.plugin(echoProvider)
  await echoFiber

  // 与提供者无关的统一请求（消费者永远不写 SDK 调用）
  const req: GenerateRequest = {
    model: 'fake-mini',
    system: '你是一个简洁的助手',
    messages: [{ role: 'user', content: '什么是 Provider？' }],
    maxTokens: 256,
  }

  // —— 消费者：发一次与提供者无关的请求 ——
  console.log('\n-- 消费者请求 router="fake"（代码与具体模型解耦）--')
  const r1 = await ctx.llm.complete('fake', req)
  console.log(`provider=${r1.provider} finish=${r1.finishReason} text=${r1.text}`)

  // —— 实验1：未知路由 → 错误归属 llm 服务，而非消费者兜底客户端 ——
  console.log('\n-- 实验1：请求未知路由 "azure"（该 Provider 未挂载）--')
  try {
    await ctx.llm.complete('azure', req)
  } catch (e) {
    console.log('捕获错误（归属 llm 服务）：', (e as Error).message)
  }

  // —— 实验2：注册重复 Provider → 路由表拒绝 ——
  console.log('\n-- 实验2：再注册同名 "fake"（应被路由表拒绝）--')
  try {
    ctx.llm.register('fake', {} as any)
  } catch (e) {
    console.log('捕获错误：', (e as Error).message)
  }

  // —— 实验3：另一条路由 "echo"，消费者请求代码完全不变 ——
  console.log('\n-- 实验3：请求 router="echo"（换部署，消费者不改一行）--')
  const r3 = await ctx.llm.complete('echo', req)
  console.log(`provider=${r3.provider} text=${r3.text}`)

  // —— 实验4：卸载 fake-provider → 仅该路由消失，llm 服务与其他路由仍在 ——
  console.log('\n-- 实验4：卸载 fake-provider（effect 回收路由）--')
  await fakeFiber.dispose()
  console.log('当前路由：', ctx.llm.list().join(', '))
  try {
    await ctx.llm.complete('fake', req)
  } catch (e) {
    console.log('再次请求 fake 报错（路由已随 Provider 卸载而消失）：', (e as Error).message)
  }
  // echo 路由仍可用，证明"模型不是运行时、只是可插拔能力"
  const r4 = await ctx.llm.complete('echo', req)
  console.log('echo 仍可用：', r4.text)

  console.log('\n=== 收尾：模型是 Provider，卸载它不影响 harness 其余能力 ===')
  await new Promise((r) => setTimeout(r, 50))
  process.exit(0)
}
