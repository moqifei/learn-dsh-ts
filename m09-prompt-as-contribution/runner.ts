/**
 * m09 · Prompt 是多方贡献 —— 运行演示
 *
 * 演示：
 *   1. 多方贡献组装：6 个分段 + 2 个变量 → 按 order 排序渲染成一整条；
 *   2. 确定性排序：贡献插件是"乱序挂载"的，但渲染顺序仍由 order 决定；
 *   3. 动态 provider：clock 段每次组装文本不同，无需重新注册；
 *   4. 卸载 fiber：dispose 一个贡献的 fiber → 该分段从下一次组装自动消失；
 *   5. 严格变量：引用未知 {{missing}} → 组装在"发请求前"失败。
 */

import { Context } from '@deepseek-ai/cordis'
import type { PromptRegistry } from './prompt.ts'
import { memoryRecallFiber } from './contributors.ts'

export const name = 'prompt-runner'
export const inject = ['prompt']

export async function apply(ctx: Context): Promise<void> {
  const prompt = ctx.prompt as PromptRegistry
  console.log('==== m09 Prompt 是多方贡献 ====\n')

  // 监听 system-prompt/change：真实实现里这让 agent loop 知道"提示词变了，需重新组装"。
  ctx.on('system-prompt/change', () => {
    console.log(`  [event] system-prompt/change → 当前分段: ${(prompt as any).sections ? [...(prompt as any).sections.keys()].join(', ') : ''}`)
  })

  // ── 1. 组装（多个插件已各自贡献分段，见 contributors.ts） ──────
  const assembly = await prompt.assemble({ meta: { turn: 1 } })
  const rendered = prompt.render(assembly)
  console.log('[组装] 渲染后的系统提示词（顺序由 order 决定，与挂载顺序无关）：')
  console.log('────────────────────────────────────────')
  console.log(rendered)
  console.log('────────────────────────────────────────\n')

  // ── 2. 确定性排序：打印参与分段 name 证明顺序 ──────
  const orderInfo = assembly.sections.map(s => `${s.name}`).join(' → ')
  console.log('[确定性排序] 参与分段：', orderInfo)

  // ── 3. 动态 provider：再次组装，clock 段文本会变 ─────────────
  const first = prompt.render(await prompt.assemble())
  const second = prompt.render(await prompt.assemble())
  console.log('\n[动态 provider] 两次组装均生成时间戳：',
    first.includes('Current time') && second.includes('Current time') ? '✅ (clock 每次重算)' : '⚠️')

  // ── 4. 卸载 fiber：dispose 一个真实贡献 → 该分段从下一次组装消失 ──
  // memoryRecallFiber 就是 contributors.ts 里 memory:recall 段被 ctx.effect
  // 托管的 disposer；真实工程里由 cordis 在贡献插件卸载时自动调用它，
  // 本课直接调用它来模拟"卸载该真实贡献"。
  console.log('\n[卸载 fiber] 调用 contributors 暴露的 memoryRecallFiber()，memory:recall 应消失：')
  const beforeSections = (await prompt.assemble()).sections.map(s => s.name)
  console.log('  卸载前含 memory:recall 段：', beforeSections.includes('memory:recall') ? '✅' : '❌')
  memoryRecallFiber?.()
  const afterSections = (await prompt.assemble()).sections.map(s => s.name)
  console.log('  卸载后含 memory:recall 段：', afterSections.includes('memory:recall') ? '❌ (仍残留)' : '✅ (已自动消失)')
  console.log('  其余分段不受影响：', afterSections.includes('harness:identity') && afterSections.includes('runtime:clock') ? '✅' : '⚠️')

  // ── 5. 严格变量：引用未知变量应失败 ─────────────────────────
  console.log('\n[严格变量] 注册引用 {{missing}} 的分段，组装应失败：')
  try {
    prompt.section({ name: 'bad:var', order: 90, text: 'x = {{missing}}' })
    const a = await prompt.assemble()
    prompt.render(a)
    console.log('  ❌ 未报错（不符合预期）')
  } catch (e) {
    console.log('  ✅ 组装前就失败：', (e as Error).message.split('；')[0])
  }

  console.log('\n==== 结束（卸载实验见第 4 步：dispose fiber → 该段从下一次 assemble 自动消失） ====')
  await new Promise((r) => setTimeout(r, 50))
  process.exit(0)
}
