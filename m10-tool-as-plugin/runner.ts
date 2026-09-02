/**
 * m10 · 工具即插件 —— 运行演示
 *
 * 演示：
 *   1. 工具即插件：三个子系统各自 register() 一个工具（乱序挂载）；
 *   2. schemas()：向模型投影"工具菜单"（不含 execute 内部字段）；
 *   3. execute()：经注册表分发执行，调用方只传 name+args；
 *   4. 卸载一个工具插件：dispose 其 fiber → 该工具从 schemas 消失，其余不受影响；
 *   5. 未知工具：execute() 返回结构化错误，而不是抛异常崩溃。
 */

import { Context } from '@deepseek-ai/cordis'
import type { ToolRegistry } from './tool.ts'
import { unregisterReadNote } from './plugins.ts'

export const name = 'tool-runner'
export const inject = ['tools']

export async function apply(ctx: Context): Promise<void> {
  const tools = ctx.tools as ToolRegistry
  console.log('==== m10 工具即插件 ====\n')

  // 监听 tools/change：真实实现里这让 agent loop 知道"可用工具集变了，重投影"。
  ctx.on('tools/change', () => {
    console.log(`  [event] tools/change → 当前可用: ${tools.names().join(', ')}`)
  })

  // ── 1. 工具已由各插件 register()（见 plugins.ts，乱序挂载） ──────
  console.log('[注册] 三个子系统已各自贡献工具（乱序挂载，集合无序）：')
  console.log('  已注册工具:', tools.names().join(', '))

  // ── 2. schemas()：投影给模型的工具菜单 ───────────────────────
  console.log('\n[投影] schemas() 给模型看的工具菜单（不含 execute）：')
  for (const s of tools.schemas()) {
    console.log(`  • ${s.name}: ${s.description}`)
  }

  // ── 3. execute()：分发执行 add ───────────────────────────────
  console.log('\n[执行] 调用 add(2,3)（调度者只传 name+args，不关心谁实现）：')
  const r1 = await tools.execute('add', { a: 2, b: 3 })
  console.log('  ', r1.isError ? '❌' : '✅', r1.content)
  console.log('[执行] 调用 read_note(home)：')
  const r2 = await tools.execute('read_note', { id: 'home' })
  console.log('  ', r2.isError ? '❌' : '✅', r2.content)

  // ── 4. 卸载一个工具插件：撤销 memory 子系统贡献的 read_note ──────
  // 真实工程里 memoryTool 是独立插件，插件卸载时 cordis 自动调用其 effect
  // 的 disposer（即删掉 read_note）；这里调用 plugins 暴露的 unregisterReadNote()
  // 模拟"该插件被卸载"——read_note 应自动消失，其余工具不受影响。
  console.log('\n[卸载插件] unregisterReadNote() → read_note 应消失：')
  console.log('  卸载前含 read_note：', tools.names().includes('read_note') ? '✅' : '❌')
  unregisterReadNote()
  console.log('  卸载后含 read_note：', tools.names().includes('read_note') ? '❌ (仍残留)' : '✅ (已自动消失)')
  console.log('  其余工具不受影响：', tools.names().includes('add') && tools.names().includes('web_search') ? '✅' : '⚠️')

  // ── 5. 未知工具：结构化错误而非崩溃 ──────────────────────────
  console.log('\n[未知工具] 调用不存在的 tool：')
  const r3 = await tools.execute('nonexistent', {})
  console.log('  ', r3.isError ? '✅ (返回结构化错误)' : '❌', r3.content)

  console.log('\n==== 结束（工具 = 插件：注册即 effect，卸载即撤销） ====')
  await new Promise((r) => setTimeout(r, 50))
  process.exit(0)
}
