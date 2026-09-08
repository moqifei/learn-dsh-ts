import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * m15 · 按需加载 Skill — 文件系统技能仓库
 *
 * 对应 Python 版 s16 的 `FileSystemSkills` 与 `Skill` / `SkillSummary`。
 *
 * 设计要点（progressive / on-demand loading）：
 *   - catalog()  只解析每个 SKILL.md 的 frontmatter（name + description），
 *     返回"摘要"列表。这一步很便宜：不读正文，不占上下文。
 *   - load(name) 才真正读取并解析某个 SKILL.md 的完整正文 body，
 *     返回"完整技能"。这一步是昂贵的、按需发生的。
 *
 * 这正是 deepseek-harness `packages/skill/skill-filesystem` 的真实思路：
 * 给模型一份 compact catalog（只包含 name/description），模型在任务匹配时
 * 通过 load_skill 工具"按需"把完整正文拉进上下文。未加载的技能正文
 * 永远不会进入上下文窗口。
 */

/** skill 名称规则：小写字母数字 + 连字符（与真实工程 isSkillName 一致）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 技能摘要（catalog 阶段产生，不含正文）。 */
export interface SkillSummary {
  readonly name: string
  readonly description: string
}

/** 完整技能（load 阶段产生，含正文）。 */
export interface Skill {
  readonly name: string
  readonly description: string
  readonly body: string
  /** 该技能文件所在目录（对应真实工程 skill_resources 的 base directory）。 */
  readonly baseDir: string
}

/** 解析 SKILL.md 得到的原始结构。 */
interface ParsedSkill {
  name: string
  description: string
  body: string
  baseDir: string
}

/**
 * 从某个目录下加载技能。
 * 约定：每个技能是一个子目录，内含一个 SKILL.md 文件，
 * 形如 `root/<skill-name>/SKILL.md`，与真实工程 `--skills-dir` 扫描一致。
 */
export class FileSystemSkills {
  private readonly root: string
  private paths: Map<string, string> | undefined

  constructor(root: string) {
    this.root = root
  }

  /** 技能根目录（供监视/热替换使用）。 */
  get rootPath(): string {
    return this.root
  }

  /**
   * 扫描 root 下所有 `<name>/SKILL.md`，返回它们的摘要（不读正文）。
   * 重复触发会重新扫描（无副作用，幂等）。
   */
  catalog(): SkillSummary[] {
    const paths = new Map<string, string>()
    const discovered: Map<string, SkillSummary> = new Map()

    const entries = readDirNames(this.root)
    for (const name of entries) {
      const manifest = join(this.root, name, 'SKILL.md')
      if (!existsSync(manifest)) continue
      let parsed: ParsedSkill
      try {
        parsed = parseSkillFile(manifest)
      } catch (e) {
        throw new Error(`cannot load skill ${name}: ${(e as Error).message}`)
      }
      if (!SKILL_NAME.test(parsed.name)) {
        throw new Error(`invalid skill name in ${manifest}: ${JSON.stringify(parsed.name)}`)
      }
      if (!parsed.description.trim()) {
        throw new Error(`missing skill description in ${manifest}`)
      }
      if (discovered.has(parsed.name)) {
        throw new Error(`duplicate skill name: ${parsed.name}`)
      }
      discovered.set(parsed.name, {
        name: parsed.name,
        description: parsed.description.split(/\s+/).join(' '),
      })
      paths.set(parsed.name, manifest)
    }

    this.paths = paths
    return [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 按需加载某个技能的完整正文。
   * @throws KeyError 形式错误：技能名不在 catalog 中。
   * @throws Error   正文为空。
   */
  load(name: string): Skill {
    if (!SKILL_NAME.test(name)) {
      throw new Error(`invalid skill name: ${JSON.stringify(name)}`)
    }
    this.catalog()
    const path = this.paths!.get(name)
    if (path === undefined) {
      const available = [...this.paths!.keys()].join(', ') || 'none'
      throw new SkillNotFoundError(`unknown skill ${JSON.stringify(name)} (available: ${available})`)
    }
    const parsed = parseSkillFile(path)
    if (!parsed.body.trim()) {
      throw new Error(`empty skill body: ${name}`)
    }
    return {
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      baseDir: parsed.baseDir,
    }
  }
}

/** 文件缺失类错误（区别于校验错误，便于调用方区分处理）。 */
export class SkillNotFoundError extends Error {}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 列出 root 下的直接子目录名（容错：目录不存在返回空）。 */
function readDirNames(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/**
 * 解析一个 SKILL.md 文件。
 * 格式（与 deepseek-harness `parseSkillFile` 一致）：
 *   ---
 *   name: <skill-name>
 *   description: <一句话描述>
 *   ---
 *   <正文指令……>
 */
function parseSkillFile(path: string): ParsedSkill {
  const text = readFileSync(path, 'utf-8')
  if (!text.startsWith('---\n')) {
    throw new Error('skill lacks YAML frontmatter')
  }
  const rest = text.slice(4)
  const sep = rest.indexOf('\n---\n')
  if (sep < 0) {
    throw new Error('unterminated YAML frontmatter')
  }
  const header = rest.slice(0, sep)
  const body = rest.slice(sep + 5)
  const meta = parseFrontmatter(header)

  const name = meta['name']
  const description = meta['description']
  if (typeof name !== 'string' || typeof description !== 'string') {
    throw new Error('frontmatter requires name and description')
  }
  return {
    name,
    description,
    body: body.trim(),
    baseDir: dirname(path),
  }
}

/**
 * 极简的 YAML frontmatter 解析器。
 * 真实工程用 js-yaml，这里为了避免引入依赖，只支持本课程用到的
 * `key: value`（标量字符串）形式。
 */
function parseFrontmatter(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of header.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    // 去掉包裹的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}
