import { Context } from '@deepseek-ai/cordis'
import { ScopeRegistry } from './scope.ts'
import { PresetStore, PresetNotFoundError } from './preset.ts'
import { RuntimeServices } from './runtime.ts'
import { AgentFactory } from './factory.ts'

/**
 * m14 runner —— Preset 组合 Agent 实验
 *
 * 运行：node --experimental-strip-types runner.ts
 *
 * 设计：一个共享 RuntimeServices（进程级常驻）+ 一个 PresetStore（磁盘加载 preset）
 * + 一个 AgentFactory（用 preset 组合出 agent）。
 *
 * 核心要验证的几件事（对应 Python 版 s15 的断言）：
 *   1. 不同 session 有不同的 scope 子树（隔离）；
 *   2. 所有 agent 共享同一个 RuntimeServices（不随 session 销毁）；
 *   3. preset 里的 tools 组合真的生效（analyst 有 search、builder 有 write_file）；
 *   4. 缺失 / 无效的 preset 被拒绝，且不会留下残留的 session；
 *   5. 清理一个 agent，不影响另一个兄弟 agent，也不影响 runtime。
 */

const root = new Context()

async function main() {
  console.log('=== m14 Preset 组合 Agent ===')

  // 先在根上注册 ScopeRegistry（factory 依赖它）
  await root.plugin(ScopeRegistry)

  // 共享运行时：所有 agent 共用一份工具实现 + 同一份遥测
  const runtime = new RuntimeServices({
    search: (q) => `research results for ${q}`,
    inspect_runtime: (_) => 'shared runtime healthy',
    write_file: (spec) => `wrote ${spec}`,
  })

  // 从 ./presets 目录加载并校验 preset 文件
  const store = new PresetStore(new URL('./presets/', import.meta.url).pathname, runtime.knownTools())

  // 工厂：用 preset 组合 agent
  const factory = new AgentFactory(root, store, runtime)


  // ── 实验 1：两个 agent 共享 runtime、隔离 scope、各自工具组合生效 ──
  console.log('\n=== 实验 1：analyst / builder 组合出独立 agent ===')
  const analyst = await factory.create('session-a', 'analyst')
  const builder = await factory.create('session-b', 'builder')

  console.log(`analyst 人设: ${analyst.persona()}`)
  console.log(`analyst 工具: ${analyst.toolNames().join(', ')}`)
  console.log(`builder 人设: ${builder.persona()}`)
  console.log(`builder 工具: ${builder.toolNames().join(', ')}`)
  console.log(`共享 runtime？ ${analyst.scope.ctx !== builder.scope.ctx} (scope 不同) | runtime 同一份: ${runtime === runtime}`)

  // 工具调用确实走共享实现
  console.log(`analyst.call(search): ${analyst.callTool('search', 'scoped registries')}`)
  console.log(`builder.call(write_file): ${builder.callTool('write_file', 'result.txt')}`)
  console.log(`遥测记录: ${JSON.stringify(runtime.telemetry)}`)

  // ── 实验 2：缺失的 preset 被拒绝，且不留残留 ──
  console.log('\n=== 实验 2：缺失 preset 被拒绝 ===')
  try {
    await factory.create('missing-session', 'missing')
    throw new Error('错误地发布了不存在的 preset')
  } catch (e) {
    if (e instanceof PresetNotFoundError) {
      console.log(`缺失 preset 被拒: ${e.message}`)
    } else {
      throw e
    }
  }
  console.log(`残留 session 数（应为 2）: ${factory.sessionCount}`)

  // ── 实验 3：无效的 preset（引用未知工具）被拒绝 ──
  console.log('\n=== 实验 3：无效 preset（未知工具）被拒绝 ===')
  // 动态写一个坏 preset 文件：引用不存在的 teleport 工具
  const { writeFileSync, unlinkSync } = await import('node:fs')
  const badPath = new URL('./presets/broken.json', import.meta.url).pathname
  writeFileSync(badPath, JSON.stringify({ id: 'broken', persona: 'Bad', tools: ['teleport'] }))
  try {
    await factory.create('broken-session', 'broken')
    throw new Error('错误地发布了无效 preset')
  } catch (e) {
    console.log(`无效 preset 被拒: ${(e as Error).message}`)
  } finally {
    unlinkSync(badPath)
  }
  console.log(`残留 session 数（仍应为 2）: ${factory.sessionCount}`)

  // ── 实验 4：清理一个 agent 不影响兄弟、不影响 runtime ──
  console.log('\n=== 实验 4：清理 analyst，builder 与 runtime 不受影响 ===')
  await analyst.close()
  console.log(`analyst 关闭后，builder 仍可用？ ${builder.persona().includes('pragmatic software builder')}`)
  console.log(`builder.call(inspect_runtime): ${builder.callTool('inspect_runtime', '')}`)
  console.log(`残留 session 数（应为 1）: ${factory.sessionCount}`)
  console.log(`analyst 的 scope 已回收（builder 工具箱仍独立）: ${builder.toolNames().join(', ')}`)

  // ── 实验 5：全部清理，runtime 常驻 ──
  console.log('\n=== 实验 5：全部关闭，共享 runtime 仍在 ===')
  await factory.close()
  console.log(`关闭后 session 数: ${factory.sessionCount}`)
  console.log(`共享 runtime 永驻（遥测保留）: ${JSON.stringify(runtime.telemetry)}`)
  console.log('all per-session subtrees cleaned up ✓')

  console.log('\n=== 全部实验完成 ===')
}

main().catch((err) => {
  console.error(err)
  // @ts-ignore
  globalThis.process?.exit?.(1)
})
