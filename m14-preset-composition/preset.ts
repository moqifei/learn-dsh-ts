import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * m14 · Preset 组合 Agent — Preset 数据模型与校验
 *
 * 对应 Python 版 s15 的 `Preset` / `PresetStore`：
 *   - 一个 preset 是一份"具名数据"（id / persona / tools），不是代码；
 *   - 它必须在发布（创建 agent）之前经过严格校验：
 *       · 文件必须存在且是合法 JSON；
 *       · 字段必须恰好是 { id, persona, tools }；
 *       · persona 不能是空串；
 *       · tools 必须是非空字符串列表、无重复、且都是运行时已知工具；
 *   - 校验失败直接拒绝，**不会**进入"创建 agent"流程。
 *
 * 这正是真实工程里"preset 是一份 composition 文件、在 mount 前被校验"的简化版。
 */

/** 一个预设的数据形状（不可变）。 */
export interface Preset {
  readonly presetId: string
  readonly persona: string
  /** 这个 preset 组合了哪些工具（按名引用，运行时再从共享仓库里取实现）。 */
  readonly tools: readonly string[]
}

/** preset 文件必须恰好包含这三个字段。 */
const REQUIRED = new Set(['id', 'persona', 'tools'])

/**
 * PresetStore：从磁盘加载并校验 preset 的仓库。
 * 它持有"已知工具集合"，用于拒绝引用了未知工具的 preset。
 */
export class PresetStore {
  private readonly root: string
  private readonly knownTools: ReadonlySet<string>

  constructor(root: string, knownTools: ReadonlySet<string>) {
    this.root = root
    this.knownTools = knownTools
  }

  /**
   * 解析并校验一个 preset。
   * @throws 文件缺失 → 抛 KeyError（形如 Python 的 KeyError，这里用 Error 子类区分）
   * @throws 任何校验不通过 → 抛 Error（含具体原因）
   */
  resolve(presetId: string): Preset {
    const path = join(this.root, `${presetId}.json`)
    if (!existsSync(path)) {
      throw new PresetNotFoundError(
        `preset ${JSON.stringify(presetId)} not found in ${this.root}`,
      )
    }

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (e) {
      throw new Error(`cannot read preset ${JSON.stringify(presetId)}: ${(e as Error).message}`)
    }

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`preset ${JSON.stringify(presetId)} must be a JSON object`)
    }
    const obj = raw as Record<string, unknown>

    // 字段集合必须恰好等于 REQUIRED
    const keys = new Set(Object.keys(obj))
    for (const k of REQUIRED) {
      if (!keys.has(k)) throw new Error(`preset ${JSON.stringify(presetId)} missing field: ${k}`)
    }
    if (keys.size !== REQUIRED.size) {
      const extra = [...keys].filter((k) => !REQUIRED.has(k))
      throw new Error(`preset ${JSON.stringify(presetId)} has unexpected field(s): ${extra.join(', ')}`)
    }

    // id 必须匹配文件名
    if (obj.id !== presetId) {
      throw new Error(`preset file/id mismatch: file is ${JSON.stringify(presetId)} but id=${JSON.stringify(obj.id)}`)
    }

    // persona 必须非空字符串
    if (typeof obj.persona !== 'string' || obj.persona.trim() === '') {
      throw new Error(`preset ${JSON.stringify(presetId)} has an empty persona`)
    }

    // tools 必须是非空字符串列表
    if (
      !Array.isArray(obj.tools) ||
      obj.tools.length === 0 ||
      obj.tools.some((t) => typeof t !== 'string')
    ) {
      throw new Error(`preset ${JSON.stringify(presetId)} tools must be a non-empty string array`)
    }
    // tools 无重复
    if (new Set(obj.tools).size !== obj.tools.length) {
      throw new Error(`preset ${JSON.stringify(presetId)} contains duplicate tools`)
    }
    // tools 必须都是已知工具
    const unknown = (obj.tools as string[]).filter((t) => !this.knownTools.has(t))
    if (unknown.length > 0) {
      throw new Error(`preset ${JSON.stringify(presetId)} names unknown tools: ${unknown.join(', ')}`)
    }

    return {
      presetId,
      persona: obj.persona.trim(),
      tools: obj.tools as string[],
    }
  }
}

/** 文件缺失类错误（区别于校验错误，便于调用方区分处理）。 */
export class PresetNotFoundError extends Error {}
