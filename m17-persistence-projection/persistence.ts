import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Session, type SessionEvent } from './session.ts'

/**
 * m17 · 持久化与投影 — 持久化层（definition / provider / consumer 三段式）
 *
 * 对应 Python s18 的 `Persistence`(Protocol) / `JsonlPersistence` / `PersistenceConsumer`，
 * 以及真实工程 `packages/session/session-persistence`(定义+coordinator) 与
 * `session-persistence-jsonl`(后端)。
 *
 * 三段式（s18 / 真实工程一致）：
 *   - **Definition**：`Persistence` 接口（append/load/close），能力名与行为稳定；
 *     Session 不依赖任何具体存储（JSONL / SQLite / 远程）。
 *   - **Provider**：`JsonlPersistence`（每行一个事件，立即 flush）+ `MemoryPersistence`（可替换演示）。
 *   - **Consumer**：`PersistenceCoordinator` 订阅 Session 的 observe，把已接受事件写进 provider；
 *     关闭时移除 observer 并关闭 provider（checkpoint = 当前最高 seq）。
 */

export interface Persistence {
  append(event: SessionEvent): void
  load(): SessionEvent[]
  close(): void
}

/** Provider：JSONL 后端（每行一个紧凑 JSON，追加不重写旧行，进程退出不丢）。 */
export class JsonlPersistence implements Persistence {
  private readonly path: string
  private buf: string[] = []
  private closed = false

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
  }

  append(event: SessionEvent): void {
    if (this.closed) throw new Error('persistence provider is closed')
    // 立即落盘（教学用同步 append；生产级需事务/fsync/校验和）
    appendFileSync(this.path, JSON.stringify(event) + '\n')
  }

  load(): SessionEvent[] {
    if (!existsSync(this.path)) return []
    const text = readFileSync(this.path, 'utf8')
    const events: SessionEvent[] = []
    text.split('\n').forEach((line, idx) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed: any
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        throw new Error(`invalid JSONL at line ${idx + 1}`)
      }
      events.push(parsed as SessionEvent)
    })
    return events
  }

  close(): void {
    this.closed = true
  }
}

/** Provider（可替换演示）：内存后端——证明换存储不需改 Session / 投影代码。 */
export class MemoryPersistence implements Persistence {
  private rows: SessionEvent[] = []
  private closed = false

  append(event: SessionEvent): void {
    if (this.closed) throw new Error('persistence provider is closed')
    this.rows.push(JSON.parse(JSON.stringify(event)))
  }

  load(): SessionEvent[] {
    return this.rows.map((r) => JSON.parse(JSON.stringify(r)))
  }

  close(): void {
    this.closed = true
  }
}

/**
 * Consumer：把 Session 的已接受事件持久化。
 * 它只知道 `Persistence` 定义，组合时注入具体 provider。
 */
export class PersistenceCoordinator {
  private disposeObserver: () => void
  private readonly provider: Persistence

  constructor(
    session: Session,
    provider: Persistence,
  ) {
    this.provider = provider
    // 订阅 Session：每次已接受事件都写进 provider（持久化观察的是"完整事实"，非派生视图）
    this.disposeObserver = session.observe((event) => this.provider.append(event))
  }

  /** 稳定关闭边界上的最高已接受 seq（对应真实工程的 checkpoint）。 */
  checkpoint(session: Session): number {
    return session.nextSeq - 1
  }

  close(): void {
    this.disposeObserver()
    this.provider.close()
  }
}
