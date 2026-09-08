import { Service } from '@deepseek-ai/cordis'
import { Session, type Event } from './session.ts'

/**
 * m16 · 上下文压缩 — 可替换策略的 Compaction 引擎
 *
 * 对应真实工程 `packages/compaction/compaction` 的 `CompactionEngine`（抽象基类，
 * `extends Service`），以及并排的多种实现：`compaction-basic` / `command-compact`
 * / `compaction-tool-result-pruner`。
 *
 * 设计要点（与真实工程一致）：
 *   - `CompactionEngine` 是抽象基类，声明契约（`compact` 等），本身 `extends Service`，
 *     以 `ctx.compaction` 注入；每个 context 只加载「一个」实现（依赖倒置）。
 *   - 具体"怎么压缩"由实现决定（保留策略不同），上层 agent loop 只依赖抽象。
 *   - 本实验给出两个可互换实现：
 *       · `CompactionBasic`   —— 保留 system + 尾部 N 条，中间段摘要（经典策略）；
 *       · `CompactionKeepRecent` —— 只保留最近 N 条事件，更旧的整段丢弃（激进策略）。
 *   - 工具结果剪枝、pressure 测量等公共能力放在抽象基类，实现复用。
 */

export interface CompactionOptions {
  /** 触发压力阈值（字节）。超过即建议压缩。 */
  pressureLimitBytes: number
  /** 工具结果剪枝阈值（字节）。超过该字节数的 result.payload 裁掉中部。 */
  toolResultPruneBytes: number
  /** 保留尾部事件条数（basic 策略的 stable-range 尾部长度）。 */
  retainTail: number
  /** keep-recent 策略保留的「最近事件」条数。 */
  keepRecent?: number
}

/** 抽象引擎：声明契约，提供公共能力（剪枝 / pressure）。具体策略由子类实现。 */
export abstract class CompactionEngine extends Service {
  static inject = [] as const

  protected readonly opts: CompactionOptions

  constructor(ctx: any, options?: Partial<CompactionOptions>) {
    super(ctx, 'compaction')
    this.opts = {
      pressureLimitBytes: options?.pressureLimitBytes ?? 600,
      toolResultPruneBytes: options?.toolResultPruneBytes ?? 320,
      retainTail: options?.retainTail ?? 1,
      keepRecent: options?.keepRecent ?? 3,
    }
  }

  options(): CompactionOptions {
    return { ...this.opts }
  }

  /** 粗略压力估算（events 字节数）。 */
  pressure(session: Session): number {
    return session.pressureBytes()
  }

  /** 是否建议压缩（超过阈值）。 */
  shouldCompact(session: Session): boolean {
    return this.pressure(session) > this.opts.pressureLimitBytes
  }

  /**
   * 工具结果剪枝：超过阈值的 result 事件，裁掉中部只留首尾。
   * 公共能力（所有策略复用），对应真实工程的 `toolResultPruneBytes`。
   */
  pruneToolResult(payload: string): string {
    if (payload.length <= this.opts.toolResultPruneBytes) return payload
    const keep = Math.floor(this.opts.toolResultPruneBytes / 2)
    const head = payload.slice(0, keep)
    const tail = payload.slice(payload.length - keep)
    return `${head} …[已省略 ${payload.length - keep * 2} 字节]… ${tail}`
  }

  /** 把事件渲染成一行 surface 文本（与 Session 里追加的规则保持一致）。 */
  renderEvent(e: Event): string {
    switch (e.type) {
      case 'message':
        return `msg(${e.role}): ${e.content}\n`
      case 'tool':
        return `tool(${e.name}): ${e.call}\n`
      case 'result':
        return `result(${e.tool}): ${e.payload}\n`
      case 'summary':
        return `[SUMMARY]: ${e.summary}\n`
    }
  }

  /**
   * 执行一次压缩（公共骨架）：子类通过 `buildSurface` 决定保留/丢弃策略。
   * 关键点：events 真相源只追加一条 summary 事件，永不被删改。
   */
  protected commit(
    session: Session,
    compressible: Event[],
    retainedSurface: string,
    summarize: (compressible: Event[], pruned: Event[]) => string,
  ): { summary: string; surface: string } {
    const pruned = compressible.map((e) =>
      e.type === 'result' ? { ...e, payload: this.pruneToolResult(e.payload) } : e,
    )
    const summary = summarize(compressible, pruned)
    const compressedSurface = `${retainedSurface}[SUMMARY]: ${summary}\n`
    session.applySummary(summary, compressedSurface)
    return { summary, surface: compressedSurface }
  }

  /** 当前策略名（用于实验观察「用的是哪个实现」）。 */
  abstract strategyName(): string

  /**
   * 执行一次压缩。子类实现决定：哪些事件被保留、哪些进摘要。
   * @param summarize 摘要函数（真实工程 = LLM；本实验 = 确定性占位）
   */
  abstract compact(
    session: Session,
    summarize: (compressible: Event[], pruned: Event[]) => string,
  ): { summary: string; surface: string }
}

// —— 实现一：经典策略（保留 system + 尾部 N 条，中间段摘要）——
export class CompactionBasic extends CompactionEngine {
  strategyName(): string {
    return 'basic（保留 system + 尾部）'
  }

  /** stable-range 选择（public，供实验直接观察保留边界）。 */
  selectStableRange(session: Session): {
    systemIndex: number
    tailFrom: number
    compressible: Event[]
  } {
    const events = session.events
    const systemIndex = events.findIndex(
      (e) => e.type === 'message' && e.role === 'system',
    )
    const tailFrom = Math.max(systemIndex + 1, events.length - (this.opts.retainTail ?? 1))
    const compressible = events.slice(systemIndex + 1, tailFrom)
    return { systemIndex, tailFrom, compressible }
  }

  compact(
    session: Session,
    summarize: (compressible: Event[], pruned: Event[]) => string,
  ): { summary: string; surface: string } {
    const events = session.events
    const { systemIndex, tailFrom, compressible } = this.selectStableRange(session)
    const systemEv = systemIndex >= 0 ? events[systemIndex] : null
    const systemLine =
      systemEv && systemEv.type === 'message' ? `msg(${systemEv.role}): ${systemEv.content}\n` : ''
    const tailLine = events.slice(tailFrom).map((e) => this.renderEvent(e)).join('')
    return this.commit(session, compressible, systemLine + tailLine, summarize)
  }
}

// —— 实现二：激进策略（只保留最近 N 条事件，更旧的整段丢弃进摘要）——
export class CompactionKeepRecent extends CompactionEngine {
  strategyName(): string {
    return `keep-recent（仅保留最近 ${this.opts.keepRecent} 条）`
  }

  compact(
    session: Session,
    summarize: (compressible: Event[], pruned: Event[]) => string,
  ): { summary: string; surface: string } {
    const events = session.events
    const keep = this.opts.keepRecent ?? 3
    // system 永远保留；其余保留最近 keep 条，更旧的参与摘要
    const systemIndex = events.findIndex(
      (e) => e.type === 'message' && e.role === 'system',
    )
    const recentFrom = Math.max(systemIndex + 1, events.length - keep)
    const compressible = events.slice(systemIndex + 1, recentFrom)
    const systemEv = systemIndex >= 0 ? events[systemIndex] : null
    const systemLine =
      systemEv && systemEv.type === 'message' ? `msg(${systemEv.role}): ${systemEv.content}\n` : ''
    const recentLine = events.slice(recentFrom).map((e) => this.renderEvent(e)).join('')
    return this.commit(session, compressible, systemLine + recentLine, summarize)
  }
}

// 让 Service 注入名被 cordis 识别（与真实工程 declare module 同构）
declare module '@deepseek-ai/cordis' {
  interface Context {
    compaction: CompactionEngine
  }
}
