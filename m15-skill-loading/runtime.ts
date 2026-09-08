import { watch, type FSWatcher } from 'node:fs'
import { Service } from '@deepseek-ai/cordis'
import { FileSystemSkills, SkillNotFoundError, type Skill, type SkillSummary } from './skill.ts'

/**
 * m15 · 按需加载 Skill — Skill 运行时 Service
 *
 * 对应 Python s16 的 `RuntimeContext` + `LOAD_SKILL_SCHEMA`，以及
 * deepseek-harness 真实工程的 `SkillRegistry`（在运行时暴露被加载技能正文
 * 给工具的机制，并支持"热替换"——不重启进程即可让改动生效）。
 *
 * 两层职责：
 *   1. 主机平面（全局单例，常驻）：持有 FileSystemSkills，对外只暴露
 *      compact catalog（摘要），永不主动把正文塞进上下文；
 *   2. 作用域平面（每个 agent scope 一份）：缓存"本作用域已加载的技能"，
 *      提供 load 工具——模型选好技能名后，才把正文按需拉进该作用域。
 *
 * 关键点：未加载的技能正文始终留在磁盘上，不进上下文；已加载的也只
 * 缓存在该作用域里，兄弟作用域看不到、dispose 后整体回收。
 *
 * 热替换（实验 6 新增，对应真实工程 SkillRegistry.invalidateCache +
 * skills/change 事件 + skill-filesystem 的 Watcher）：
 *   - invalidate()   把 revision+1 并清空"已加载缓存"，广播 skills/change；
 *   - watch()        用 fs.watch 订阅技能目录，文件改动即自动 invalidate；
 *   - onChange()     订阅者可在不重启进程的前提下，监听失效、刷新自己的快照。
 *
 * 与 m13/m14 一致：按 scopeKey 分桶，监听 'scope/disposed' 自清理。
 */
export class SkillService extends Service {
  static inject = ['scopes'] as const

  private readonly fs: FileSystemSkills
  /** 每个作用域已加载的技能正文（按 scopeKey 分桶，局部可见）。 */
  private readonly loadedByScope = new Map<string, Map<string, Skill>>()
  /** 乐观并发版本号：每次失效自增，用于缓存时效性判定。 */
  private revision = 0
  /** skills/change 的订阅回调集合（对应真实工程的 changedListeners）。 */
  private readonly changeListeners = new Set<() => void>()
  /** 当前打开的 fs.watch 句柄（实验 6 用，对应真实工程的 SkillWatchManager）。 */
  private watcher: FSWatcher | undefined

  constructor(ctx: any, root: string) {
    super(ctx, 'skills')
    this.fs = new FileSystemSkills(root)
  }

  /** 紧凑目录（不含正文），供系统提示词渲染。 */
  catalog(): SkillSummary[] {
    return this.fs.catalog()
  }

  /** 当前失效版本号，供调用方判断缓存是否过期。 */
  getRevision(): number {
    return this.revision
  }

  /**
   * 按需加载某个技能到指定作用域（对应 load_skill 工具）。
   * 必须显式传入 scopeKey，因为 Service 挂在全局 ctx 上，
   * 不能从 this.ctx 推断"当前"作用域——这正是作用域隔离的边界。
   *
   * 与真实工程一致：每次 load 都重新从磁盘读取（不命中正文缓存），
   * 因此失效之后的下一次 load 自然拿到新版本——这就是"热替换"的本质：
   * 失效 + 惰性重建，而非把新内容"推送"进内存。
   * @returns 完整技能（含正文）。失败抛错由调用方处理。
   */
  load(scopeKey: string, name: string): Skill {
    const skill = this.fs.load(name)
    let bucket = this.loadedByScope.get(scopeKey)
    if (!bucket) {
      bucket = new Map()
      this.loadedByScope.set(scopeKey, bucket)
    }
    bucket.set(skill.name, skill)
    return skill
  }

  /** 某作用域已加载的技能名列表。 */
  loadedNames(scopeKey: string): string[] {
    const bucket = this.loadedByScope.get(scopeKey)
    return bucket ? [...bucket.keys()].sort() : []
  }

  /** 读取某作用域某技能的已加载正文（未加载则返回 undefined）。 */
  bodyOf(scopeKey: string, name: string): string | undefined {
    return this.loadedByScope.get(scopeKey)?.get(name)?.body
  }

  /**
   * 作用域销毁时，清空该作用域的已加载技能缓存。
   * 通过监听 'scope/disposed' 实现，与 m13 登记表自清理同构。
   */
  onScopeDisposed(key: string): void {
    this.loadedByScope.delete(key)
  }

  // ---------------------------------------------------------------------------
  // 热替换：失效 + 惰性重建（对应真实工程 SkillRegistry.invalidateCache）
  // ---------------------------------------------------------------------------

  /**
   * 失效：让"已加载缓存"作废，并广播 skills/change。
   *
   * 与真实工程同构：
   *   - revision++      → 标记时代更迭，后续 load 视为"新版本"；
   *   - clear cache     → 已加载正文清空，下次 load 重新读盘；
   *   - notifyChange()  → 广播事件，订阅方（如当前对话的 catalog 快照）可刷新。
   *
   * 注意：invalidate 不会立刻重读磁盘，agent 继续用旧知识；
   * 真正的"新内容"在下次 load 时才惰性进入——这正是快照稳定性的保证。
   */
  invalidate(): void {
    this.revision += 1
    this.loadedByScope.clear()
    this.notifyChange()
  }

  /**
   * 订阅 skills/change（对应真实工程的 ctx.on('skills/change', ...)）。
   * @returns 取消订阅函数。
   */
  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb)
    return () => {
      this.changeListeners.delete(cb)
    }
  }

  /**
   * 用 fs.watch 订阅技能根目录，文件改动即自动 invalidate。
   * 对应真实工程 SkillWatchManager 的 host watcher（polling / inotify）。
   * 这是"不重启 agent 即可热替换"的触发器来源。
   */
  watch(): void {
    if (this.watcher) return
    this.watcher = watch(
      this.fs.rootPath,
      { recursive: true },
      (_event, filename) => {
        // 只关心 SKILL.md 相关改动
        if (!filename || String(filename).includes('SKILL.md')) {
          this.invalidate()
        }
      },
    )
  }

  /** 关闭目录监视并释放句柄。 */
  closeWatch(): void {
    this.watcher?.close()
    this.watcher = undefined
  }

  private notifyChange(): void {
    for (const cb of [...this.changeListeners]) {
      try {
        cb()
      } catch {
        /* 订阅方异常不应打断失效流程，与真实工程一致 */
      }
    }
  }
}

export { SkillNotFoundError }
