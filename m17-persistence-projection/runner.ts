import { Context } from '@deepseek-ai/cordis'
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createScope, ScopeRegistry } from './scope.ts'
import { Session, ProjectionCache, type SessionEvent } from './session.ts'
import { JsonlPersistence, MemoryPersistence, PersistenceCoordinator } from './persistence.ts'

// 让自定义事件被 cordis 类型系统识别
declare module '@deepseek-ai/cordis' {
  interface Events {
    'scope/disposed': (key: string) => void
  }
  interface Context {
    scopes: ScopeRegistry
  }
}

const root = new Context()

/**
 * 读取课程 cordis.yml，演示"配置驱动"：持久化后端来自配置，而非硬编码。
 * 对应 m09~m12 系列里 cordis.yml 驱动插件装配的做法（m13 起未再出现，m16/m17 恢复）。
 */
function loadConfig() {
  const raw = readFileSync(join(process.cwd(), 'cordis.yml'), 'utf8')
  const backendM = raw.match(/backend:\s*(\w+)/)
  return {
    backend: (backendM ? backendM[1] : 'jsonl') as 'jsonl' | 'memory',
    file: (raw.match(/file:\s*(\S+)/)?.[1] ?? 'session.jsonl'),
    writeEveryEvents: Number(raw.match(/write_every_events:\s*(\d+)/)?.[1] ?? 3),
  }
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `m17-persist-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function main() {
  const cfg = loadConfig()
  console.log('  从 cordis.yml 读到的持久化配置:', JSON.stringify(cfg))

  await root.plugin((ctx: any) => {
    ctx.scopes = new ScopeRegistry(ctx)
  })

  const experiments = [
    exp1_appendPersists,
    exp2_coldRestoreEquals,
    exp3_projectionWatermark,
    exp4_badRowRejected,
    exp5_swapProvider,
  ]
  let allPass = true
  for (const [i, fn] of experiments.entries()) {
    try {
      await fn(root, cfg)
      console.log(`\n✅ 实验 ${i + 1} 通过`)
    } catch (e) {
      allPass = false
      console.error(`\n❌ 实验 ${i + 1} 失败:`, (e as Error).message)
    }
  }

  if (!allPass) process.exit(1)
}

// 实验 1：append 即持久化（已接受事实立刻落盘，进程退出不丢）
async function exp1_appendPersists(root: Context, cfg: ReturnType<typeof loadConfig>) {
  const dir = makeTempDir()
  const path = join(dir, cfg.file)
  const provider = cfg.backend === 'memory' ? new MemoryPersistence() : new JsonlPersistence(path)
  const session = new Session()
  const coordinator = new PersistenceCoordinator(session, provider)

  session.append('session/title', { title: 'Atlas recovery drill' })
  session.append('user/message', { content: '记住密钥 LANTERN-204' })
  session.append('assistant/message', { content: '已记住 LANTERN-204' })
  session.append('tool/result', { name: 'health', content: 'ok' })

  const checkpoint = coordinator.checkpoint(session)
  coordinator.close()

  // 重新从磁盘加载（模拟进程重启），无需 session 对象
  const reloaded = provider.load()
  console.log('  持久化行数:', reloaded.length, '| checkpoint:', checkpoint)
  if (reloaded.length !== 4) throw new Error('持久化行数与 append 数不符')
  if (reloaded.length - 1 !== checkpoint) throw new Error('checkpoint 不等于最高 seq')
  if (!reloaded.some((e) => e.type === 'user/message' && e.data.content.includes('LANTERN-204'))) {
    throw new Error('关键信息未持久化')
  }
  // 即便不依赖原 session，也能从磁盘重建事实
  const restored = new Session()
  restored.hydrate(reloaded)
  console.log('  从磁盘重放后得到 user 消息数:', restored.deriveMessages().length)
  if (restored.deriveMessages().length !== 2) throw new Error('重放后消息数不对')
  rmSync(dir, { recursive: true, force: true })
}

// 实验 2：冷恢复 —— 冷推导出的 model 消息 == 关闭前推导出的消息
async function exp2_coldRestoreEquals(root: Context, cfg: ReturnType<typeof loadConfig>) {
  const dir = makeTempDir()
  const path = join(dir, cfg.file)
  const provider = new JsonlPersistence(path)
  const session = new Session()
  const coordinator = new PersistenceCoordinator(session, provider)

  session.append('session/title', { title: 'Atlas recovery drill' })
  session.append('session/status', { status: 'active' })
  session.append('user/message', { content: '记住 LANTERN-204' })
  const preCloseMessages = session.deriveMessages()

  const checkpoint = coordinator.checkpoint(session)
  coordinator.close()

  // —— 冷恢复：读盘行 → 全新 Session 水合 ——
  const coldProvider = new JsonlPersistence(path)
  const rows = coldProvider.load()
  coldProvider.close()
  const restored = new Session()
  restored.hydrate(rows)
  const restoredSeq = restored.nextSeq - 1

  console.log('  checkpoint:', checkpoint, '| restored seq:', restoredSeq)
  console.log('  pre-close 消息:', JSON.stringify(preCloseMessages))
  console.log('  cold 推导消息:', JSON.stringify(restored.deriveMessages()))
  console.log('  冷消息 == 关闭前消息:', JSON.stringify(restored.deriveMessages()) === JSON.stringify(preCloseMessages))
  if (restoredSeq !== checkpoint) throw new Error('恢复 seq 与 checkpoint 不符')
  if (JSON.stringify(restored.deriveMessages()) !== JSON.stringify(preCloseMessages)) {
    throw new Error('冷恢复消息与关闭前不一致')
  }
  rmSync(dir, { recursive: true, force: true })
}

// 实验 3：投影增量 watermark —— fold 幂等，缺 seq 抛错
async function exp3_projectionWatermark(root: Context, _cfg: ReturnType<typeof loadConfig>) {
  const session = new Session()
  session.append('session/title', { title: 'Drill' })
  session.append('user/message', { content: 'hi' })
  session.append('assistant/message', { content: 'hello' })
  session.append('tool/result', { name: 'x', content: 'y' })
  session.append('session/status', { status: 'idle' })

  const cache = ProjectionCache.empty()
  cache.fold(session.events)
  const wm1 = cache.watermark
  console.log('  第一次 fold: transcript行=', cache.transcript.length, '| title=', cache.latestTitle, '| toolCount=', cache.toolCount, '| watermark=', wm1)
  if (cache.transcript.length !== 2) throw new Error('transcript 应 2 行')
  if (cache.latestTitle !== 'Drill') throw new Error('title 未折叠')
  if (cache.toolCount !== 1) throw new Error('toolCount 未折叠')

  // 幂等：再 fold 同一批事件，watermark 不变
  cache.fold(session.events)
  console.log('  第二次 fold: watermark=', cache.watermark, '（应仍 =', wm1, '）')
  if (cache.watermark !== wm1) throw new Error('重复 fold 破坏了 watermark 幂等性')

  // 缺口检测：跳过一条再 fold，应抛 seq gap
  const broken: SessionEvent[] = [session.events[0], session.events[2]]
  const cache2 = ProjectionCache.empty()
  let threw = false
  try {
    cache2.fold(broken)
  } catch (e) {
    threw = (e as Error).message.includes('sequence gap')
  }
  console.log('  fold 缺 seq 中间一行时抛 sequence gap:', threw)
  if (!threw) throw new Error('缺口未被检测')
}

// 实验 4：坏行 / 缺口 / schema 错误 → 冷加载拒绝（恢复不猜测）
async function exp4_badRowRejected(root: Context, cfg: ReturnType<typeof loadConfig>) {
  const dir = makeTempDir()
  const path = join(dir, cfg.file)

  // 写一条合法 + 一条缺失 seq 的坏行
  writeFileSync(path, JSON.stringify({
    schema: 1, seq: 0, time: 1, type: 'user/message', data: { content: 'ok' },
  }) + '\n')
  writeFileSync(path, JSON.stringify({
    schema: 1, seq: 2, time: 2, type: 'user/message', data: { content: 'gap here' },
  }) + '\n')

  // 用 Session.hydrate 重放（与冷加载同一校验路径）
  const rows = new JsonlPersistence(path).load()
  const restored = new Session()
  let threw = false
  try {
    restored.hydrate(rows)
  } catch (e) {
    threw = (e as Error).message.includes('non-contiguous')
  }
  console.log('  冷加载对 seq 缺口拒绝:', threw, '| 错误信息:', threw ? 'non-contiguous seq' : '未拒绝')
  if (!threw) throw new Error('seq 缺口未被拒绝')

  // schema 错误同样拒绝
  const dir2 = makeTempDir()
  const path2 = join(dir2, cfg.file)
  writeFileSync(path2, JSON.stringify({
    schema: 2, seq: 0, time: 1, type: 'user/message', data: { content: 'x' },
  }) + '\n')
  const restored2 = new Session()
  let threwSchema = false
  try {
    restored2.hydrate(new JsonlPersistence(path2).load())
  } catch (e) {
    threwSchema = (e as Error).message.includes('unsupported schema')
  }
  console.log('  冷加载对坏 schema 拒绝:', threwSchema)
  if (!threwSchema) throw new Error('坏 schema 未被拒绝')
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
}

// 实验 5：换 provider（memory ↔ jsonl）不碰 Session / 投影代码
async function exp5_swapProvider(root: Context, _cfg: ReturnType<typeof loadConfig>) {
  const dir = makeTempDir()
  const path = join(dir, 'swap.jsonl')

  function runWith(provider: JsonlPersistence | MemoryPersistence): string[] {
    const session = new Session()
    const coord = new PersistenceCoordinator(session, provider)
    session.append('user/message', { content: 'A' })
    session.append('assistant/message', { content: 'B' })
    const msgs = session.deriveMessages().map((m) => m.content)
    coord.close()
    return msgs
  }

  const mem = runWith(new MemoryPersistence())
  const disk = runWith(new JsonlPersistence(path))
  console.log('  Memory 后端消息:', JSON.stringify(mem))
  console.log('  JSONL 后端消息:', JSON.stringify(disk))

  // Session / 投影代码一字未改；仅 provider 不同，视图来源一致
  if (JSON.stringify(mem) !== JSON.stringify(disk)) throw new Error('换 provider 后视图不一致')
  if (!existsSync(path)) throw new Error('JSONL 后端未落盘')
  rmSync(dir, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
