import { Context } from '@deepseek-ai/cordis'
import { createScope, ScopeRegistry } from './scope.ts'

import { SkillService, SkillNotFoundError } from './runtime.ts'
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 让自定义事件被 cordis 类型系统识别
declare module '@deepseek-ai/cordis' {
  interface Events {
    'scope/disposed': (key: string) => void
    'skills/change': () => void
  }
  interface Context {
    scopes: ScopeRegistry
    skills: SkillService
  }
}

const root = new Context()

async function main() {
  // 准备临时技能目录（含若干 SKILL.md），模拟真实工程的 --skills-dir
  const skillDir = makeTempSkillDir()

  // 实验前先挂 ScopeRegistry（全局单例）
  await root.plugin(ScopeRegistry)
  // 再挂 SkillService（依赖 scopes，并持有 skillDir 根）
  await root.plugin((ctx: any) => {
    const svc = new SkillService(ctx, skillDir)
    ctx.skills = svc
    // 作用域销毁 → 清理该作用域的已加载缓存
    ctx.on('scope/disposed', (key: string) => svc.onScopeDisposed(key))
    // 热替换：skills/change 广播 → 这里转发到 cordis 事件总线
    svc.onChange(() => ctx.emit('skills/change'))
  })

  const experiments = [
    exp1_catalogIsCompact,
    exp2_onDemandLoad,
    exp3_unknownRejected,
    exp4_isolationBetweenScopes,
    exp5_disposeCleansCache,
    exp6_hotSwapWithoutRestart,
  ]
  let allPass = true
  for (const [i, fn] of experiments.entries()) {
    try {
      await fn(root, skillDir)
      console.log(`\n✅ 实验 ${i + 1} 通过`)
    } catch (e) {
      allPass = false
      console.error(`\n❌ 实验 ${i + 1} 失败:`, (e as Error).message)
    }
  }

  try {
    rmSync(skillDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  if (!allPass) process.exit(1)
}

// 实验 1：catalog 只含摘要，不含正文
async function exp1_catalogIsCompact(root: Context, _skillDir: string) {
  const catalog = root.skills.catalog()
  const names = catalog.map((s) => s.name).sort()
  if (JSON.stringify(names) !== JSON.stringify(['incident-triage', 'release-notes'])) {
    throw new Error(`catalog 名称不符: ${names.join(', ')}`)
  }
  console.log('  catalog 条目数:', catalog.length)
  console.log('  compact 描述:', catalog.map((s) => `${s.name}=${s.description}`).join(' | '))
  console.log('  关键：SkillSummary 上根本没有 body 字段，正文留在磁盘')
}

// 实验 2：按需加载 —— 只有调用 load 才拿到正文
async function exp2_onDemandLoad(root: Context, _skillDir: string) {
  const scope = await createScope(root, 'agent-oncall')
  root.scopes.register(scope)

  // 未加载时取不到正文
  if (root.skills.bodyOf(scope.key, 'incident-triage') !== undefined) {
    throw new Error('未加载却读到了正文，违背按需加载')
  }

  const skill = root.skills.load(scope.key, 'incident-triage')
  if (!skill.body.includes('立即隔离')) {
    throw new Error('加载后正文缺失关键指令')
  }
  if (root.skills.bodyOf(scope.key, 'incident-triage') !== skill.body) {
    throw new Error('已加载正文无法读取')
  }
  console.log('  未加载时 bodyOf:', 'undefined')
  console.log('  调用 load("incident-triage") 后正文长度:', skill.body.length, '字符')
  console.log('  正文首句:', skill.body.split('\n')[0])
  console.log('  该作用域已加载:', root.skills.loadedNames(scope.key).join(', '))

  await scope.dispose()
}

// 实验 3：加载未知技能必须被拒绝
async function exp3_unknownRejected(root: Context, _skillDir: string) {
  const scope = await createScope(root, 'agent-strict')
  root.scopes.register(scope)
  try {
    root.skills.load(scope.key, 'teleport')
    await scope.dispose()
    throw new Error('加载不存在的技能竟被允许')
  } catch (e) {
    if (!(e instanceof SkillNotFoundError)) {
      await scope.dispose()
      throw new Error(`应抛 SkillNotFoundError，却抛了 ${(e as Error).constructor.name}`)
    }
    console.log('  尝试 load("teleport") → 抛错:', (e as Error).message)
  }
  await scope.dispose()
}

// 实验 4：两个作用域各自加载，互不串门
async function exp4_isolationBetweenScopes(root: Context, _skillDir: string) {
  const a = await createScope(root, 'agent-A')
  const b = await createScope(root, 'agent-B')
  root.scopes.register(a)
  root.scopes.register(b)

  root.skills.load(a.key, 'incident-triage')
  // B 没有加载任何东西
  console.log('  agent-A 已加载:', root.skills.loadedNames(a.key).join(', '))
  console.log('  agent-B 已加载:', root.skills.loadedNames(b.key).join(', '))
  // B 主动去取 A 加载过的技能正文，应取不到（分桶）
  if (root.skills.bodyOf(b.key, 'incident-triage') !== undefined) {
    throw new Error('B 作用域不应看到 A 加载的技能')
  }
  await a.dispose()
  await b.dispose()
}

// 实验 5：dispose 作用域后，已加载缓存被回收
async function exp5_disposeCleansCache(root: Context, _skillDir: string) {
  const scope = await createScope(root, 'agent-ephemeral')
  root.scopes.register(scope)
  root.skills.load(scope.key, 'release-notes')
  if (root.skills.loadedNames(scope.key).length !== 1) {
    throw new Error('加载后缓存应为 1')
  }
  console.log('  dispose 前已加载:', root.skills.loadedNames(scope.key).join(', '))
  await scope.dispose()
  console.log('  dispose 后登记表 keys:', root.scopes.keys().join(', ') || '（空）')
  console.log('  缓存已随作用域销毁被回收（bodyOf 返回:', root.skills.bodyOf('agent-ephemeral', 'release-notes') ?? 'undefined', '）')
}

// 实验 6：热替换 —— 改文件后不重启进程，下次 load 拿到新版本
//
// 演示真实工程的「失效 + 惰性重建」机制（SkillRegistry.invalidateCache +
// skills/change + skill-filesystem 的 Watcher）：
//   1. 先 load 一次拿到旧正文；
//   2. 启动 fs.watch 订阅技能目录，改写 SKILL.md；
//   3. watcher 触发 invalidate() → revision++ → 已加载缓存清空 → 广播 skills/change；
//   4. 再次 load 同一技能名，从磁盘重新读取 → 自动拿到新正文。
// 整个过程中 agent 进程从未退出/重启。
async function exp6_hotSwapWithoutRestart(root: Context, skillDir: string) {
  const scope = await createScope(root, 'agent-hot')
  root.scopes.register(scope)

  const v1 = root.skills.load(scope.key, 'incident-triage')
  console.log('  热替换前（load 第 1 次）正文含「立即隔离」:', v1.body.includes('立即隔离'))
  const revBefore = root.skills.getRevision()

  // 订阅 skills/change，证明进程内事件已广播（未重启）
  let changeFired = false
  const off = root.skills.onChange(() => {
    changeFired = true
  })

  // 启动目录监视（对应真实工程的 SkillWatchManager）
  root.skills.watch()

  // 改写磁盘上的 SKILL.md —— 模拟"运营人员编辑了技能"
  const newBody = [
    '---',
    'name: incident-triage',
    'description: 生产事故的分级与初步处置流程',
    '---',
    '【v2 新版本】先拉流量开关，再降级，最后止血。',
    '新增：自动拉起 incident 频道并 @oncall。',
  ].join('\n')
  writeFileSync(join(skillDir, 'incident-triage', 'SKILL.md'), newBody)

  // 等待 watcher 异步触发 invalidate
  await delay(120)
  off()
  root.skills.closeWatch()

  if (!changeFired) {
    throw new Error('skills/change 未触发（热替换失效链路中断）')
  }
  if (root.skills.getRevision() <= revBefore) {
    throw new Error('revision 未自增（缓存未失效）')
  }

  // 关键点：进程未重启，重新 load 同一名字 → 拿到新正文
  const v2 = root.skills.load(scope.key, 'incident-triage')
  console.log('  热替换后（load 第 2 次）revision:', revBefore, '→', root.skills.getRevision())
  console.log('  热替换后正文含「v2 新版本」:', v2.body.includes('v2 新版本'))
  console.log('  热替换后正文仍含旧词「立即隔离」:', v2.body.includes('立即隔离'), '（应为 false）')
  if (!v2.body.includes('v2 新版本')) {
    throw new Error('热替换失败：重新加载未拿到新版本正文')
  }
  if (v2.body.includes('立即隔离')) {
    throw new Error('热替换失败：仍读到被覆盖的旧内容')
  }

  await scope.dispose()
}

// ---- 工具 ----
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---- 临时技能目录 ----
function makeTempSkillDir(): string {
  const dir = join(tmpdir(), `m15-skills-${Date.now()}`)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'incident-triage'), { recursive: true })
  mkdirSync(join(dir, 'release-notes'), { recursive: true })
  writeFileSync(
    join(dir, 'incident-triage', 'SKILL.md'),
    [
      '---',
      'name: incident-triage',
      'description: 生产事故的分级与初步处置流程',
      '---',
      '立即隔离故障爆炸半径，先止血再定位。',
      '逐条核查：1) 影响面 2) 回滚可行性 3) 通知链路。',
    ].join('\n'),
  )
  writeFileSync(
    join(dir, 'release-notes', 'SKILL.md'),
    [
      '---',
      'name: release-notes',
      'description: 撰写版本发布说明的规范',
      '---',
      '按 新增 / 修复 / 变更 三类组织，每条用用户视角描述价值。',
    ].join('\n'),
  )
  return dir
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
