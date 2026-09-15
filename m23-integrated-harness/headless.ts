/**
 * m23 · 集成快照 · `headless` profile 消费端（雏形，对应 s24 applyConfig/applyProfile）
 *
 * 这个文件不是"新能力"，而是树的消费端：读任务 → 跑 Agent Loop（m12）→ 端到端产出 →
 * teardown 后从 JSONL（m17）冷投影验证。换 profile（tui/web）只换这个文件，能力插件不动。
 *
 * 精确任务（s24 同构）：加载 report-format 技能 → 委派研究子代理 → 写 report.txt → 读回 → 收尾。
 */
import { Context } from '@deepseek-ai/cordis'
import { AgentLoop, PersistenceService, coldProject, SessionEvent } from './services.ts'

interface HeadlessConfig {
  task?: string
  workspaceRoot?: string
  skillsRoot?: string
  persistencePath?: string
}

const headlessPlugin = {
  name: 'headless-profile',
  inject: ['agent', 'session', 'skills', 'workspace', 'persistence', 'external', 'tools', 'metrics', 'tracing'] as const,
  async apply(ctx: Context, config: HeadlessConfig) {
    console.log('[headless] apply start')
    const agent = ctx.agent as AgentLoop
    const persistence = ctx.persistence as PersistenceService
    const tools = ctx.tools as { schemas: () => Array<Record<string, unknown>> }
    const tracing = ctx.tracing as { startRun: (t: string) => void; endRun: () => Array<{ name: string; ms: number }> }
    const metrics = ctx.metrics as { snapshot: () => Record<string, number> }

    // 等外部能力 Provider（含 web/lsp 异步 effect）完成挂载
    const ext = ctx.external as { namespaces: () => string[] }
    const deadline = Date.now() + 3000
    while (ext.namespaces().length < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }

    console.log('──────── m23 集成快照 · headless profile ────────\n')
    console.log('[profile] 已装配能力命名空间:', ext.namespaces().join(', '))

    const task = config.task ?? '请加载 report-format 技能，委派研究，写出并读回 report.txt。'
    console.log('[profile] task:', task)

    // 新 session：清空冷投影文件，避免跨运行累积
    persistence.reset()

    console.log('\n[run] agent.loop 接手任务（load_skill → delegate → write_file → read_file）……')
    tracing.startRun(task)
    const answer = await agent.run(task)
    console.log('[run] Loop 返回:', answer)

    // 自省：直接列工具树（core + external + capability-tools 全混在同一 ctx.tools）
    console.log('\n[自省] 工具树快照:')
    const names: string[] = tools.schemas().map((s) => (s.function as { name: string }).name)
    console.log('  ', names.join(', '))

    // 运行期可观测性（m13 tracing / m14 metrics / m08 events）
    console.log('\n[观测] tracing spans:')
    console.log(tracing.endRun().map((s) => `  - ${s.name} (${s.ms}ms)`).join('\n'))
    console.log('\n[观测] metrics snapshot:', JSON.stringify(metrics.snapshot()))

    // teardown：关闭持久化（停止落盘）
    persistence.close()

    // 冷投影（m17）：进程已 teardown，仅从 JSONL 重建
    const events = persistence.load() as SessionEvent[]
    const proj = coldProject(events)
    console.log('\n[冷投影] 从 session.jsonl 重建（不依赖运行期服务）:')
    console.log('  ', JSON.stringify(proj, null, 0))

    // 断言 s24 关键不变量
    const assert = (cond: boolean, msg: string) => console.log(`  ${cond ? '✅' : '❌'} ${msg}`)
    assert(proj.status === 'completed', 'turn 正常结束（Loop 自然停止，未超限）')
    assert(proj.toolNames.includes('load_skill'), '使用了 load_skill（m15 技能）')
    assert(proj.toolNames.includes('delegate_research'), '使用了 delegate_research（m19 子代理）')
    assert(proj.toolNames.includes('write_file') && proj.toolNames.includes('read_file'), '使用了 write/read_file（m10 工作区）')
    assert(proj.requestCount >= 4, '模型至少 4 次请求（m07 Provider 决策）')

    // 验证文件内容确实落盘（workspace 文件根）
    const ws = ctx.workspace as { read: (n: string) => string }
    console.log('\n[文件] report.txt 内容:')
    console.log('  ', ws.read('report.txt').replace(/\n/g, ' | '))

    console.log('\n──────── headless profile 完成，退出 ────────')
    process.exit(0)
  },
}

export default headlessPlugin
