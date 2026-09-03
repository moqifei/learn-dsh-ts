/**
 * m11 · 策略包裹执行 · 运行演示
 * 五个实验：① 正常执行被三层策略包裹 ② 拦截策略短路 ③ 超时策略抛错
 *          ④ 错误标准化 ⑤ 热卸载某策略后执行行为改变
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from './runtime.ts'
import { strategies, timeoutDisposer, guardDisposer } from './strategies.ts'
import type { ToolResult } from './runtime.ts'

async function main(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(strategies)

  const runtime = ctx.executor as ToolRuntime

  // 订阅最终标准化结果（真实工程里记忆 / 日志 / UI 都挂这里）
  ctx.on('tools/result', (r: ToolResult) => {
    console.log(`    📡 tools/result:`, JSON.stringify(r))
  })

  const nl = () => console.log('')

  // ── 实验 1：正常执行被三层策略包裹 ──────────────────────────────────────
  console.log('① 正常调用 add（被 pre/execute/post 三层策略包裹）')
  const r1 = await runtime.execute({
    id: 'c1',
    name: 'add',
    arguments: { a: 2, b: 3 },
  })
  console.log('   结果：', JSON.stringify(r1))
  nl()

  // ── 实验 2：拦截策略短路 ────────────────────────────────────────────────
  console.log('② 调用 danger/wipe（被拦截策略短路，不真正执行）')
  const r2 = await runtime.execute({
    id: 'c2',
    name: 'danger/wipe',
    arguments: {},
  })
  console.log('   结果（interceptedBy 应为 guard）：', JSON.stringify(r2))
  nl()

  // ── 实验 3：超时策略抛错 ────────────────────────────────────────────────
  console.log('③ 调用 slow echo（会被超时策略在 50ms 后中断）')
  const r3 = await runtime.execute({
    id: 'c3',
    name: 'echo',
    arguments: { text: 'hello', __sleepMs: 500 },
  })
  console.log('   结果（应含 timeout 错误）：', JSON.stringify(r3))
  nl()

  // ── 实验 4：错误标准化 ──────────────────────────────────────────────────
  console.log('④ 调用未知工具 unknown（异常被后处理策略标准化）')
  const r4 = await runtime.execute({
    id: 'c4',
    name: 'unknown',
    arguments: {},
  })
  console.log('   结果（应含结构化 error）：', JSON.stringify(r4))
  nl()

  // ── 实验 5：热卸载"超时策略"后，慢调用不再被超时 ─────────────────────────
  console.log('⑤ 热卸载"超时策略"后，再次调用 slow echo')
  timeoutDisposer?.() // 真卸载 contributors 里的一条真实策略
  const r5 = await runtime.execute({
    id: 'c5',
    name: 'echo',
    arguments: { text: 'survived', __sleepMs: 10 },
  })
  console.log('   结果（超时策略已卸载，正常返回）：', JSON.stringify(r5))
  nl()

  // ── 追加：热卸载"拦截策略"后，危险调用不再被拦 ─────────────────────────
  console.log('⑥ 热卸载"拦截策略"后，再次调用 danger/wipe')
  guardDisposer?.()
  const r6 = await runtime.execute({
    id: 'c6',
    name: 'danger/wipe',
    arguments: {},
  })
  console.log('   结果（拦截策略已卸载，进入执行层抛 unknown tool）：', JSON.stringify(r6))
  nl()

  console.log('✅ m11 策略包裹执行演示完成')
  await new Promise((r) => setTimeout(r, 50))
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
