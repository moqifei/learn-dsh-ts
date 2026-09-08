import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createScope, ScopeRegistry } from './scope.ts'
import { Session, type Event } from './session.ts'
import {
  CompactionEngine,
  CompactionBasic,
  CompactionKeepRecent,
} from './compaction.ts'

// 让自定义事件被 cordis 类型系统识别
declare module '@deepseek-ai/cordis' {
  interface Events {
    'scope/disposed': (key: string) => void
  }
  interface Context {
    scopes: ScopeRegistry
    compaction: CompactionEngine
  }
}

const root = new Context()

/**
 * 读取课程 cordis.yml，演示"配置驱动"：压缩阈值 + 选用哪个策略实现，都来自配置文件。
 * 对应 m09~m12 系列里 cordis.yml 驱动插件装配的做法（m13 起未再出现，m16 恢复），
 * 也对应真实工程中"每个 context 加载一个 CompactionEngine 实现作为 ctx.compaction"。
 */
function loadConfig() {
  const raw = readFileSync(join(process.cwd(), 'cordis.yml'), 'utf8')
  const m = raw.match(/compaction-basic:[\s\S]*?options:([\s\S]*?)(?:\n\S|\Z)/)
  const optBlock = m ? m[1] : ''
  const num = (key: string, fallback: number) => {
    const mm = optBlock.match(new RegExp(`${key}:\\s*(\\d+)`))
    return mm ? Number(mm[1]) : fallback
  }
  const stratM = raw.match(/strategy:\s*(\w+)/)
  return {
    pressureLimitBytes: num('pressure_limit_bytes', 600),
    toolResultPruneBytes: num('tool_result_prune_bytes', 320),
    retainTail: num('retain_tail', 1),
    keepRecent: num('keep_recent', 3),
    strategy: (stratM ? stratM[1] : 'basic') as 'basic' | 'keep-recent',
  }
}

/** 按 cordis.yml 的 strategy 选择一个 CompactionEngine 实现（依赖倒置）。 */
function makeEngine(ctx: any, cfg: ReturnType<typeof loadConfig>): CompactionEngine {
  const opts = {
    pressureLimitBytes: cfg.pressureLimitBytes,
    toolResultPruneBytes: cfg.toolResultPruneBytes,
    retainTail: cfg.retainTail,
    keepRecent: cfg.keepRecent,
  }
  return cfg.strategy === 'keep-recent'
    ? new CompactionKeepRecent(ctx, opts)
    : new CompactionBasic(ctx, opts)
}

async function main() {
  const cfg = loadConfig()
  console.log('  从 cordis.yml 读到的压缩配置:', JSON.stringify(cfg))

  await root.plugin((ctx: any) => {
    ctx.scopes = new ScopeRegistry(ctx)
    ctx.compaction = makeEngine(ctx, cfg) // 加载「一个」实现作为 ctx.compaction
  })

  const experiments = [
    exp1_appendOnlyEvents,
    exp2_pruneToolResult,
    exp3_stableRange,
    exp4_compactRebuildsSurface,
    exp5_scopedSessions,
    exp6_swappableStrategy,
  ]
  let allPass = true
  for (const [i, fn] of experiments.entries()) {
    try {
      await fn(root)
      console.log(`\n✅ 实验 ${i + 1} 通过`)
    } catch (e) {
      allPass = false
      console.error(`\n❌ 实验 ${i + 1} 失败:`, (e as Error).message)
    }
  }

  if (!allPass) process.exit(1)
}

// 实验 1：events 只追加，compaction 永远不删历史
async function exp1_appendOnlyEvents(root: Context) {
  const scope = await createScope(root, 'agent-append')
  root.scopes.register(scope)
  const session = new Session()
  session.message('system', '你是一个运维助手')
  session.message('user', '查下日志')
  session.tool('search', 'grep ERROR')
  session.result('search', 'ERROR: timeout\nERROR: oom')

  const beforeCount = session.events.length
  console.log('  压缩前 events 条数:', beforeCount, '| surface 含 ERROR:', session.surface.includes('ERROR'))

  // 即便"压缩"了，events 只增不减（多了一条 summary 事件）
  root.compaction.compact(session, () => '摘要: 用户查了日志')
  console.log('  压缩后 events 条数:', session.events.length, '(应 =', beforeCount + 1, ', 只追加)')
  if (session.events.length !== beforeCount + 1) {
    throw new Error('events 被删减了，违反 append-only')
  }
  // surface 变了，但原始 result 仍在 events 里
  if (!session.events.some((e) => e.type === 'result' && e.payload.includes('ERROR: oom'))) {
    throw new Error('原始历史在 events 里丢失')
  }
  await scope.dispose()
}

// 实验 2：工具结果剪枝 —— 超长 result 在送摘要前被裁掉中部
async function exp2_pruneToolResult(root: Context) {
  const scope = await createScope(root, 'agent-prune')
  root.scopes.register(scope)
  const session = new Session()
  session.message('system', 'sys')
  const huge = 'X'.repeat(800) // 远超 toolResultPruneBytes(320)
  session.result('search', huge)

  const pruned = root.compaction.pruneToolResult(huge)
  console.log('  原始 payload 长度:', huge.length, '| 剪枝后长度:', pruned.length)
  console.log('  剪枝后保留首尾:', pruned.startsWith('XX'), '且含省略标记:', pruned.includes('已省略'))
  if (!pruned.includes('已省略')) throw new Error('剪枝未生效')
  if (pruned.length >= huge.length) throw new Error('剪枝后反而更长')

  // 正常长度不剪
  const small = 'Y'.repeat(50)
  if (root.compaction.pruneToolResult(small) !== small) throw new Error('短结果被误剪')
  console.log('  短结果(50字节)不剪枝: 原样保留 =', root.compaction.pruneToolResult(small) === small)
  await scope.dispose()
}

// 实验 3：stable-range 选择 —— 保留 system + 尾部，中间历史参与摘要
async function exp3_stableRange(root: Context) {
  const scope = await createScope(root, 'agent-range')
  root.scopes.register(scope)
  const session = new Session()
  session.message('system', 'sys-prompt')
  session.message('user', 'step1')
  session.tool('a', 'call-a')
  session.result('a', 'r-a')
  session.message('user', 'step2') // 尾部（retainTail=1，这条会被保留）

  const { systemIndex, tailFrom, compressible } = (root.compaction as CompactionBasic).selectStableRange(session)
  console.log('  systemIndex:', systemIndex, '| tailFrom:', tailFrom)
  console.log('  可压缩段条数:', compressible.length, '| 尾部保留:', session.events.slice(tailFrom).map((e: Event) => e.type))
  if (systemIndex !== 0) throw new Error('system 未被识别为第 0 条')
  if (!session.events.slice(tailFrom).some((e) => e.type === 'message' && (e as any).content === 'step2')) {
    throw new Error('尾部 step2 未保留')
  }
  if (compressible.some((e) => (e as any).content === 'step2')) throw new Error('尾部不应进入可压缩段')
  await scope.dispose()
}

// 实验 4：一次压缩重建 surface（system + [SUMMARY] + 尾部），真相源不动
async function exp4_compactRebuildsSurface(root: Context) {
  const scope = await createScope(root, 'agent-compact')
  root.scopes.register(scope)
  const session = new Session()
  session.message('system', 'sys-prompt')
  session.message('user', '查订单')
  session.tool('db', 'select ...')
  session.result('db', 'A'.repeat(400)) // 长结果，会被剪枝
  session.message('user', '再查一次') // 尾部

  console.log('  压缩前 pressure(字节):', root.compaction.pressure(session), '| shouldCompact:', root.compaction.shouldCompact(session))

  const { summary, surface } = root.compaction.compact(session, (comp, pruned) => {
    return `压缩了 ${comp.length} 条（含 ${pruned.filter((e) => e.type === 'result').length} 条已剪枝结果）`
  })
  console.log('  摘要:', summary)
  console.log('  新 surface 含 [SUMMARY]:', surface.includes('[SUMMARY]:'))
  console.log('  新 surface 保留 system:', surface.includes('sys-prompt'))
  console.log('  新 surface 保留尾部"再查一次":', surface.includes('再查一次'))
  console.log('  新 surface 不再含原始长结果 AAAA...:', !surface.includes('A'.repeat(40)))
  console.log('  新 surface 含省略标记:', surface.includes('已省略'))

  if (!surface.includes('[SUMMARY]:')) throw new Error('surface 未写入摘要')
  if (!surface.includes('sys-prompt')) throw new Error('system 未被保留')
  if (!surface.includes('再查一次')) throw new Error('尾部未保留')
  if (surface.includes('A'.repeat(40))) throw new Error('长结果未从 surface 移除')
  // events 真相源仍在
  if (!session.events.some((e) => e.type === 'result' && (e as any).payload.includes('AAAA'))) {
    throw new Error('原始长结果在 events 里丢失')
  }
  await scope.dispose()
}

// 实验 5：作用域隔离 —— 每个 agent scope 一份独立 Session，互不串门
async function exp5_scopedSessions(root: Context) {
  const a = await createScope(root, 'agent-A')
  const b = await createScope(root, 'agent-B')
  root.scopes.register(a)
  root.scopes.register(b)

  const sa = new Session()
  sa.message('user', 'A 的会话')
  const sb = new Session()
  sb.message('user', 'B 的会话')

  // 只压缩 A 的会话
  root.compaction.compact(sa, () => 'A 摘要')
  console.log('  A surface 含 A 摘要:', sa.surface.includes('A 摘要'))
  console.log('  B surface 仍含"B 的会话":', sb.surface.includes('B 的会话'), '且不含摘要:', !sb.surface.includes('[SUMMARY]'))
  if (!sa.surface.includes('A 摘要')) throw new Error('A 的压缩未生效')
  if (sb.surface.includes('[SUMMARY]')) throw new Error('B 的会话被 A 的压缩串门了')

  await a.dispose()
  await b.dispose()
  console.log('  A/B 作用域已 dispose（各自 Session 随作用域回收）')
}

// 实验 6：可替换策略 —— 调用方代码不变，换实现即换压缩行为
//
// 对应真实工程：agent loop 只依赖抽象 CompactionEngine，具体用哪个策略由装配决定。
// 这里构造同一个「超长对话」会话，分别用 CompactionBasic 与 CompactionKeepRecent
// 压缩，证明：
//   - 两个实现都对同一份 events 只追加一条 summary（真相源不丢）；
//   - 但保留策略不同：basic 保留 system + 尾部 stepN；keep-recent 只保留最近 N 条；
//   - 调用方 root.compaction.compact(...) 的写法完全一致，零改动。
async function exp6_swappableStrategy(root: Context) {
  // 构造一个带 system 的较长会话：step1..step5 + 长工具结果
  function buildSession(): Session {
    const s = new Session()
    s.message('system', 'sys-prompt')
    for (let i = 1; i <= 5; i++) s.message('user', `step${i}`)
    s.result('search', 'Z'.repeat(400))
    return s
  }

  // 策略 A、B 用两个独立的新 Context 作为各自引擎的挂载点（彼此隔离，也不与 root 冲突）。
  // 注意：compact() 只用到引擎自身的 commit/pruneToolResult，不依赖 ctx 注入，
  // 因此这里无需把引擎注册进 root 的 ctx.compaction 树。
  const ctxA = new Context()
  const ctxB = new Context()
  const engineA = new CompactionBasic(ctxA, { retainTail: 1 })
  const engineB = new CompactionKeepRecent(ctxB, { keepRecent: 3 })

  // 同一份「超长对话」会话，分别用两种策略压缩
  const sa = buildSession()
  const sb = buildSession()

  const rA = engineA.compact(sa, (comp) => `摘要了 ${comp.length} 条`)
  console.log('  策略A(' + engineA.strategyName() + '):')
  console.log('    保留 system:', rA.surface.includes('sys-prompt'),
    '| 保留尾部 result:', rA.surface.includes('ZZZZ'),
    '| 丢弃 step1:', !rA.surface.includes('step1'))
  if (!rA.surface.includes('sys-prompt')) throw new Error('A: system 未保留')
  if (!rA.surface.includes('ZZZZ')) throw new Error('A: 尾部 result 未保留')
  if (rA.surface.includes('step1')) throw new Error('A: step1 应被摘要丢弃')
  if (sa.events.filter((e) => e.type === 'summary').length !== 1) {
    throw new Error('A: events 应只追加 1 条 summary')
  }

  const rB = engineB.compact(sb, (comp) => `摘要了 ${comp.length} 条`)
  console.log('  策略B(' + engineB.strategyName() + '):')
  console.log('    保留 system:', rB.surface.includes('sys-prompt'),
    '| 保留 step4/step5:', rB.surface.includes('step4') && rB.surface.includes('step5'),
    '| 丢弃 step1:', !rB.surface.includes('step1'))
  if (!rB.surface.includes('sys-prompt')) throw new Error('B: system 未保留')
  if (!rB.surface.includes('step4')) throw new Error('B: 最近 step4 未保留')
  if (!rB.surface.includes('step5')) throw new Error('B: 最近 step5 未保留')
  if (rB.surface.includes('step1')) throw new Error('B: step1 应被丢弃')
  if (sb.events.filter((e) => e.type === 'summary').length !== 1) {
    throw new Error('B: events 应只追加 1 条 summary')
  }

  // 关键：两次调用方代码完全相同（都是 engine.compact(session, fn)），
  // 差异完全来自「装配时选了哪个实现」——这正是依赖倒置 / 策略可替换。
  console.log('  调用方代码对两种策略完全一致（engine.compact 签名相同），差异仅来自实现选择')

  // 再验证默认装配路径：root.compaction 是 cordis.yml 选的实现
  console.log('  root.compaction 当前策略:', (root.compaction as any).strategyName())
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
