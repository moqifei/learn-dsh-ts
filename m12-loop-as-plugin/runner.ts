/**
 * m12 · Loop 也是插件 · 运行演示
 * 四个实验（各自独立 Context 装配，演示"换插件 = 换装配"，而非运行时热替换）：
 *   ① 基础 turn：默认装配 → Loop 协调模型+工具，模型自行停止
 *   ② 替换 LLM provider：同一 AgentLoop，换一个脚本模型（新装配）
 *   ③ 卸载工具：echo 从工具注册表移除，模型不再发起该调用（Loop 自适应）
 *   ④ 替换驱动器：提供一个新的 `agent` 服务（单次请求），能力插件不动
 */
import { Context } from '@deepseek-ai/cordis'
import { ScriptedLlm } from './llm.ts'
import type { ModelResponse } from './llm.ts'
import { AgentLoop } from './loop.ts'
import { ToolRegistry } from './tools.ts'
import {
  llmPlugin,
  promptPlugin,
  sessionPlugin,
  toolsPlugin,
  echoToolPlugin,
  agentLoopPlugin,
} from './plugins.ts'

const nl = () => console.log('')

// 挂载能力插件；skipLlm 用于"换 provider"实验（由调用方自行提供 llm）
async function installCapabilities(ctx: Context, skipLlm = false): Promise<void> {
  if (!skipLlm) await ctx.plugin(llmPlugin)
  await ctx.plugin(promptPlugin)
  await ctx.plugin(sessionPlugin)
  await ctx.plugin(toolsPlugin)
  await ctx.plugin(echoToolPlugin)
}

async function main(): Promise<void> {
  // ── 实验 1：基础 turn ───────────────────────────────────────────────────
  console.log('① 基础 turn：用户提问 → Loop 协调 → 模型调用 echo → 自行停止')
  const ctx = new Context()
  await installCapabilities(ctx)
  await ctx.plugin(agentLoopPlugin)
  const final1 = await (ctx.agent as AgentLoop).run('请通过工具回声验证 loop 插件已激活')
  console.log('   最终回答：', final1)
  nl()

  // ── 实验 2：替换 LLM provider（保持 AgentLoop 不变）───────────────────────
  console.log('② 替换 LLM provider：保持 AgentLoop 代码不变，换一个"直接回答"的脚本模型')
  class DirectLlm extends ScriptedLlm {
    async complete(): Promise<ModelResponse> {
      console.log('    🤖 [DirectLlm] 直接回答，不调用工具')
      return { text: 'hello from direct provider', toolCalls: [], finishReason: 'stop' }
    }
  }
  const ctx2 = new Context()
  await installCapabilities(ctx2, /* skipLlm */ true)
  await ctx2.plugin(DirectLlm) // 提供新的 llm 服务
  await ctx2.plugin(agentLoopPlugin)
  const final2 = await (ctx2.agent as AgentLoop).run('hi')
  console.log('   最终回答：', final2)
  console.log('   ⇒ AgentLoop 代码一字未改，只换了 provider 插件')
  nl()

  // ── 实验 3：卸载工具，Loop 自适应 ───────────────────────────────────────
  console.log('③ 卸载 echo 工具后，再次跑 turn')
  const tools = ctx.tools as ToolRegistry
  tools.unregister('echo') // 真卸载 contributors 里的一条真实工具贡献
  console.log('   当前工具表仍含 echo？', tools.has('echo'))
  const final3 = await (ctx.agent as AgentLoop).run('没有 echo 了，直接回答吧')
  console.log('   最终回答：', final3)
  console.log('   ⇒ 工具从 schema 中消失，模型自适应为直接回答')
  nl()

  // ── 实验 4：替换驱动器（提供新的 agent 服务）────────────────────────────
  console.log('④ 替换驱动器：提供一个"只发一次请求"的 SingleShotAgent')
  class SingleShotAgent extends AgentLoop {
    async run(userInput: string): Promise<string> {
      const llm = this.ctx.llm as ScriptedLlm
      const out = await llm.complete({
        system: '',
        messages: [{ role: 'user', content: userInput }],
        tools: [],
      })
      return `[singleshot] ${out.text || '(no text)'}`
    }
  }
  const ctx3 = new Context()
  await installCapabilities(ctx3)
  await ctx3.plugin(SingleShotAgent) // 提供新的 agent 服务（新 ctx 内无冲突）
  const final4 = await (ctx3.agent as AgentLoop).run('hi')
  console.log('   最终回答：', final4)
  console.log('   ⇒ 同一组能力（llm/session/prompt/tools）之上，换驱动器无需改它们')
  nl()

  console.log('✅ m12 Loop 也是插件 演示完成')
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
