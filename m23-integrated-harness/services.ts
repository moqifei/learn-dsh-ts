/**
 * m23 · 集成 Harness · 全部能力 Service 定义
 *
 * 本课把 m07–m22 串成一份 s24 同构的集成快照。所有部件都先在此定义为 Service，
 * 再由各自插件经 `super(ctx, name)` 注册进同一根 Context —— "一切皆为插件"的落点。
 *
 * 本课覆盖（对应 s24 profile.json 的 10 个插件 + m22 external）：
 *   model(m07) session(m08) prompt-registry(m09) tool-registry(m10)
 *   workspace(m10) skills(m15) policy(m11) persistence(m17)
 *   subagent(m19) agent-loop(m12) capability-external(m22)
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { mkdirSync, readFileSync, existsSync, readdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: ModelService
    session: SessionService
    prompt: PromptRegistry
    tools: ToolRegistry
    workspace: WorkspaceService
    skills: SkillsService
    policy: PolicyService
    persistence: PersistenceService
    subagents: SubagentRuntime
    external: CapabilityRuntime
    agent: AgentLoop
    bus: BusService
    metrics: MetricsService
    tracing: TracingService
  }
}

// ───────────────────────────── m07 · Model（Provider 注册表） ─────────────────────────────

/** 教学用脚本 Provider：根据已发生的工具事件决定下一步调用（确定性、可复现）。 */
class HeadlessModelProvider implements ModelProvider {
  async generate(req: GenerateRequest): Promise<ModelResponse> {
    const session = (this as any)._session as SessionService | undefined
    const names = (req.tools ?? []).map((t) => (t.function as { name: string }).name)
    const has = (n: string) => names.includes(n)
    const saw = (t: string) => session?.eventsLog().some((e) => e.type === 'tool/result' && e.data.name === t) ?? false

    if (has('load_skill') && !saw('load_skill'))
      return { text: '', toolCalls: [{ id: 'c1', name: 'load_skill', arguments: { name: 'report-format' } }], finishReason: 'tool_calls' }
    if (has('delegate_research') && !saw('delegate_research'))
      return { text: '', toolCalls: [{ id: 'c2', name: 'delegate_research', arguments: { task: 'Append-only events 与 pre-execution policy 的技术证据' } }], finishReason: 'tool_calls' }
    if (has('write_file') && !saw('write_file'))
      return {
        text: '',
        toolCalls: [
          {
            id: 'c3',
            name: 'write_file',
            arguments: { name: 'report.txt', content: 'TITLE=Integrated Harness Evidence\nFACT_ONE=Append-only events support cold projection.\nFACT_TWO=Tool policy runs before execution.\nSTATUS=VERIFIED' },
          },
        ],
        finishReason: 'tool_calls',
      }
    if (has('read_file') && !saw('read_file'))
      return { text: '', toolCalls: [{ id: 'c4', name: 'read_file', arguments: { name: 'report.txt' } }], finishReason: 'tool_calls' }

    return { text: 'Report completed and verified.', toolCalls: [], finishReason: 'stop' }
  }
}

export interface ModelToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}
export interface ModelResponse {
  text: string
  toolCalls: ModelToolCall[]
  finishReason: string
}
export interface ModelProvider {
  generate(req: GenerateRequest): Promise<ModelResponse>
}
export interface GenerateRequest {
  model: string
  system: string
  messages: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  maxTokens?: number
}

export class ModelService extends Service {
  static readonly methods = ['register', 'complete']
  static inject = ['session'] as const
  private readonly providers = new Map<string, ModelProvider>()
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'llm')
    void config
    // 默认 provider：教学脚本模型（自身构造内注册，无竞争）
    const headless = new HeadlessModelProvider()
    ;(headless as unknown as { _session: SessionService })._session = ctx.session as SessionService
    this.register('headless', headless)
  }
  register(router: string, provider: ModelProvider): void {
    if (this.providers.has(router)) throw new Error(`duplicate provider "${router}"`)
    this.providers.set(router, provider)
    this.ctx.logger.info(`[model] register provider: ${router}`)
  }
  async complete(router: string, req: GenerateRequest): Promise<ModelResponse & { provider: string }> {
    const p = this.providers.get(router)
    if (p === undefined) throw new Error(`unknown provider "${router}"`)
    return { provider: router, ...(await p.generate(req)) }
  }
}

// ───────────────────────────── m08 · Session（事件溯源） ─────────────────────────────

export interface SessionEvent {
  schema: string
  seq: number
  time: string
  type: string
  data: Record<string, unknown>
}

export class SessionService extends Service {
  static readonly methods = ['append', 'messages', 'eventsLog']
  private events: SessionEvent[] = []
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'session')
    void config
  }
  append(type: string, data: Record<string, unknown>): void {
    const ev: SessionEvent = { schema: 'session/v1', seq: this.events.length, time: new Date().toISOString(), type, data }
    this.events.push(ev)
    // 事件溯源：每次 append 立即广播，persistence consumer 订阅落盘（m17）
    ;(this.ctx as any).emit('session/event', ev)
  }
  messages(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = []
    for (const ev of this.events) {
      const d = ev.data
      if (ev.type === 'user/message') out.push({ role: 'user', content: d.content })
      else if (ev.type === 'assistant/message') {
        const msg: Record<string, unknown> = { role: 'assistant', content: d.content || null }
        if (Array.isArray(d.toolCalls) && d.toolCalls.length) {
          msg.tool_calls = (d.toolCalls as Array<Record<string, unknown>>).map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          }))
        }
        out.push(msg)
      } else if (ev.type === 'tool/result') out.push({ role: 'tool', tool_call_id: d.callId, content: d.content })
    }
    return out
  }
  eventsLog(): SessionEvent[] {
    return this.events
  }
}

// ───────────────────────────── m09 · PromptRegistry（有序贡献） ─────────────────────────────

export class PromptRegistry extends Service {
  static readonly methods = ['register', 'render']
  private contributions = new Map<number, { key: string; text: string }>()
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'prompt')
    void config
    this.register(0, 'role', 'You are a headless coding agent assembled from plugins.')
    this.register(10, 'format', 'When asked to write a report, call load_skill then delegate then write_file then read_file.')
  }
  register(order: number, key: string, text: string): () => void {
    if (this.contributions.has(order)) throw new Error(`prompt order ${order} already registered`)
    this.contributions.set(order, { key, text })
    this.ctx.logger.info(`[prompt] register section @${order}: ${key}`)
    return () => this.contributions.delete(order)
  }
  render(): string {
    return [...this.contributions.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c]) => c.text)
      .join('\n\n')
  }
}

// ───────────────────────────── m10 · ToolRegistry（守卫流水线） ─────────────────────────────

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>
}
export type ToolGuard = (call: { name: string; arguments: Record<string, unknown> }) => boolean | Promise<boolean>

export class ToolRegistry extends Service {
  static readonly methods = ['register', 'schemas', 'execute', 'addGuard', 'has', 'unregister']
  private defs = new Map<string, ToolDef>()
  private guards: ToolGuard[] = []
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'tools')
    void config
  }
  register(def: ToolDef): () => void {
    if (this.defs.has(def.name)) throw new Error(`tool "${def.name}" already registered`)
    this.defs.set(def.name, def)
    this.ctx.logger.info(`[tools] register: ${def.name}`)
    return () => this.unregister(def.name)
  }
  addGuard(g: ToolGuard): () => void {
    this.guards.push(g)
    return () => {
      const i = this.guards.indexOf(g)
      if (i >= 0) this.guards.splice(i, 1)
    }
  }
  schemas(): Array<Record<string, unknown>> {
    return [...this.defs.values()].map((d) => ({
      type: 'function',
      function: { name: d.name, description: d.description, parameters: d.parameters },
    }))
  }
  async execute(call: { id: string; name: string; arguments: Record<string, unknown> }): Promise<{
    callId: string
    name: string
    content: unknown
    isError: boolean
  }> {
    const def = this.defs.get(call.name)
    if (def === undefined) return { callId: call.id, name: call.name, content: `unknown tool: ${call.name}`, isError: true }
    // 守卫流水线（m11）：执行前逐个 guard，拒绝则记录 guard_denied 并不执行
    const session = this.ctx.get('session') as SessionService | undefined
    session?.append('tool/guard_started', { name: call.name })
    for (let i = 0; i < this.guards.length; i++) {
      const ok = await this.guards[i](call)
      if (!ok) {
        session?.append('tool/guard_denied', { name: call.name, guard: i })
        return { callId: call.id, name: call.name, content: `guard ${i} denied: ${call.name}`, isError: true }
      }
    }
    session?.append('tool/guard_allowed', { name: call.name })
    try {
      const value = await def.execute(call.arguments)
      return { callId: call.id, name: call.name, content: value, isError: false }
    } catch (err) {
      return { callId: call.id, name: call.name, content: `${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  }
  has(name: string): boolean {
    return this.defs.has(name)
  }
  unregister(name: string): void {
    this.defs.delete(name)
  }
}

// ───────────────────────────── m10 · Workspace（受限文件根） ─────────────────────────────

export class WorkspaceService extends Service {
  static readonly methods = ['write', 'read', 'root']
  private rootDir: string
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'workspace')
    this.rootDir = (config.root as string) ?? join(process.cwd(), 'state', 'workspace')
    mkdirSync(this.rootDir, { recursive: true })
  }
  /** 策略（m11）会校验解析后路径仍落在 rootDir 之下，否则抛错。 */
  resolve(p: string): string {
    const full = resolve(this.rootDir, p)
    const rel = relative(this.rootDir, full)
    if (rel.startsWith('..') || rel === '..') throw new Error(`path escapes workspace: ${p}`)
    return full
  }
  write(name: string, content: string): string {
    const full = this.resolve(name)
    writeFileSync(full, content)
    return full
  }
  read(name: string): string {
    const full = this.resolve(name)
    return readFileSync(full, 'utf8')
  }
  root(): string {
    return this.rootDir
  }
  reset(): void {
    rmSync(this.rootDir, { recursive: true, force: true })
    mkdirSync(this.rootDir, { recursive: true })
  }
}

// ───────────────────────────── m15 · Skills（目录 + 按需加载） ─────────────────────────────

export class SkillsService extends Service {
  static readonly methods = ['catalog', 'load']
  private rootDir: string
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'skills')
    this.rootDir = (config.root as string) ?? join(process.cwd(), 'skills')
  }
  /** 只解析 frontmatter（name/description），便宜，不读正文。 */
  catalog(): Array<{ name: string; description: string }> {
    if (!existsSync(this.rootDir)) return []
    const out: Array<{ name: string; description: string }> = []
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const md = join(this.rootDir, entry.name, 'SKILL.md')
      if (!existsSync(md)) continue
      const text = readFileSync(md, 'utf8')
      const fm = text.match(/^---\n([\s\S]*?)\n---/)
      const name = (fm?.[1].match(/name:\s*(.+)/)?.[1] ?? entry.name).trim()
      const description = (fm?.[1].match(/description:\s*(.+)/)?.[1] ?? '').trim()
      out.push({ name, description })
    }
    return out
  }
  /** 按需才读完整正文。 */
  load(name: string): { name: string; description: string; body: string } {
    const dir = join(this.rootDir, name)
    const md = join(dir, 'SKILL.md')
    if (!existsSync(md)) throw new Error(`skill not found: ${name}`)
    const text = readFileSync(md, 'utf8')
    const fm = text.match(/^---\n([\s\S]*?)\n---/)
    const description = (fm?.[1].match(/description:\s*(.+)/)?.[1] ?? '').trim()
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
    return { name, description, body }
  }
}

// ───────────────────────────── m11 · Policy（执行前守卫） ─────────────────────────────

export class PolicyService extends Service {
  static readonly methods = ['allowFile']
  static inject = ['tools'] as const
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'policy')
    void config
    // 在工具守卫流水线挂一道：文件类工具仅允许策略白名单（report.txt）
    ctx.effect(() => {
      const tools = ctx.get('tools', false) as { addGuard: (g: (c: any) => boolean) => () => void }
      return tools.addGuard((call) => {
        if (call.name === 'write_file' || call.name === 'read_file') return this.allowFile(String(call.arguments.name))
        return true
      })
    })
  }
  /** 工作区策略：只允许对 report.txt 做文件调用（s24 同构）。 */
  allowFile(name: string): boolean {
    return name === 'report.txt'
  }
}

// ───────────────────────────── m17 · Persistence（JSONL 追加） ─────────────────────────────

export class PersistenceService extends Service {
  static readonly methods = ['append', 'load', 'close', 'path', 'reset']
  private readonly file: string
  private closed = false
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'persistence')
    this.file = (config.path as string) ?? join(process.cwd(), 'state', 'session.jsonl')
    mkdirSync(dirname(this.file), { recursive: true })
    // consumer：订阅 session 广播，立即落盘（append-only，进程退出不丢）
    ;(ctx as any).on('session/event', (ev: SessionEvent) => {
      if (!this.closed) appendFileSync(this.file, JSON.stringify(ev) + '\n', 'utf8')
    })
  }
  append(ev: SessionEvent): void {
    if (!this.closed) appendFileSync(this.file, JSON.stringify(ev) + '\n', 'utf8')
  }
  // 开始新 session 前清空（冷投影演示用；生产可改为按 sessionId 分文件）
  reset(): void {
    if (existsSync(this.file)) writeFileSync(this.file, '')
  }
  load(): SessionEvent[] {
    if (!existsSync(this.file)) return []
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as SessionEvent)
  }
  path(): string {
    return this.file
  }
  close(): void {
    this.closed = true
  }
}

// ───────────────────────────── m19 · Subagent（委派，普通工具） ─────────────────────────────

export interface SubagentProvider {
  start(req: { prompt: string; parent: string }): Promise<{ output: string; stopReason: string }>
}
export class SubagentRuntime extends Service {
  static readonly methods = ['registerProvider', 'start']
  private providers = new Map<string, SubagentProvider>()
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'subagents')
    void config
    this.registerProvider('research', {
      async start(req) {
        return {
          output: `research: ${req.prompt} -> append-only events give cold projection; pre-execution policy denies out-of-root writes.`,
          stopReason: 'end_turn',
        }
      },
    })
  }
  registerProvider(name: string, p: SubagentProvider): void {
    this.providers.set(name, p)
    this.ctx.logger.info(`[subagent] register provider: ${name}`)
  }
  async start(name: string, req: { prompt: string; parent: string }): Promise<{ output: string; stopReason: string }> {
    const p = this.providers.get(name)
    if (p === undefined) throw new Error(`unknown subagent provider: ${name}`)
    return p.start(req)
  }
}

// ───────────────────────────── m22 · External（外部能力消费视图） ─────────────────────────────

export interface MountedTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: unknown) => unknown | Promise<unknown>
}
export interface ExternalCapabilityProvider {
  readonly namespace: string
  listTools(): Promise<MountedTool[]> | MountedTool[]
  close(): void | Promise<void>
}

// ---- 三类外部能力 Provider（结构同构，经同一 Runtime 接入）----

class CoreProvider implements ExternalCapabilityProvider {
  readonly namespace = 'core'
  listTools(): MountedTool[] {
    return [
      {
        name: 'add',
        description: 'Add two integers (core, in-process).',
        parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } } },
        execute: (a: any) => a.a + a.b,
      },
    ]
  }
  close(): void {}
}

class WebProvider implements ExternalCapabilityProvider {
  readonly namespace = 'web'
  private server: any
  constructor(private readonly cfg: { baseUrl: string; path: string }) {}
  async start(): Promise<void> {
    const http = await import('node:http')
    this.server = http.createServer((_q, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, service: 'demo-status', uptime: 42 }))
    })
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(8765, '127.0.0.1', () => resolve())
    }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') console.warn('[web] 8765 已被占用，复用既有服务')
      else throw err
    })
  }
  close(): void {
    try {
      this.server?.close()
    } catch {
      /* ignore */
    }
  }
  listTools(): MountedTool[] {
    return [
      {
        name: 'status',
        description: `Return demo service status from ${this.cfg.baseUrl}.`,
        parameters: { type: 'object', properties: {} },
        execute: async () => (await fetch(`${this.cfg.baseUrl}${this.cfg.path}`)).json(),
      },
    ]
  }
}

class LspTeachingProvider implements ExternalCapabilityProvider {
  readonly namespace = 'lsp'
  private child: any
  constructor(private readonly cfg: { command: string; args: string[] }) {}
  async start(): Promise<void> {
    const { spawn } = await import('node:child_process')
    this.child = spawn(this.cfg.command, this.cfg.args, { stdio: ['pipe', 'pipe', 'inherit'] })
  }
  close(): void {
    try {
      this.child?.kill()
    } catch {
      /* ignore */
    }
  }
  listTools(): MountedTool[] {
    return [
      {
        name: 'symbol',
        description: 'Look up a symbol via the teaching LSP subprocess.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        execute: async (a: any) => [{ name: String(a.query), kind: 'Class', location: 'demo.ts:1' }],
      },
    ]
  }
}
export class CapabilityRuntime extends Service {
  static readonly methods = ['registerProvider', 'schemas', 'execute', 'namespaces']
  static inject = ['tools'] as const
  private registry = new Map<string, ExternalCapabilityProvider>()
  private disposers = new Map<string, () => void>()
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'external')
    void config
    // 默认 provider：core（进程内）/ web（真实回环 HTTP）/ lsp（真实子进程）
    const webCfg = (config.web as { baseUrl: string; path: string }) ?? { baseUrl: 'http://127.0.0.1:8765', path: '/status.json' }
    const lspCfg = (config.lsp as { command: string; args: string[] }) ?? { command: 'node', args: ['./lsp-server.js'] }
    this.registerProvider('core', new CoreProvider())
    const web = new WebProvider(webCfg)
    this.registerProvider('web', web)
    const lsp = new LspTeachingProvider(lspCfg)
    this.registerProvider('lsp', lsp)
    // 启连接（异步）在 effect 内完成
    this.ctx.effect(async () => {
      await web.start().catch(() => {})
      await lsp.start().catch(() => {})
      return () => {
        web.close()
        lsp.close()
      }
    })
  }
  registerProvider(name: string, provider: ExternalCapabilityProvider): void {
    if (this.registry.has(name)) throw new Error(`provider "${name}" already registered`)
    this.registry.set(name, provider)
    this.ctx.effect(() => {
      Promise.resolve(provider.listTools()).then((tools) => this.mount(name, tools))
      return () => this.unmount(name)
    })
  }
  private mount(ns: string, tools: MountedTool[]): void {
    const toolsSvc = this.ctx.get('tools', false) as ToolRegistry | undefined
    if (toolsSvc === undefined) return
    for (const t of tools) {
      const full = `cap__${ns}__${t.name}`
      this.disposers.set(full, toolsSvc.register({ name: full, description: t.description, parameters: t.parameters, execute: t.execute }))
      this.ctx.logger.info(`[capability] mounted: ${full}`)
    }
  }
  private unmount(ns: string): void {
    for (const [name, dispose] of [...this.disposers]) {
      if (name.startsWith(`cap__${ns}__`)) {
        dispose()
        this.disposers.delete(name)
      }
    }
  }
  namespaces(): string[] {
    return [...this.registry.keys()]
  }
  schemas(): Array<Record<string, unknown>> {
    const toolsSvc = this.ctx.get('tools', false) as ToolRegistry | undefined
    if (toolsSvc === undefined) return []
    return toolsSvc.schemas().filter((s) => (s.function as { name: string }).name.startsWith('cap__'))
  }
  async execute(name: string, args: unknown): Promise<unknown> {
    const toolsSvc = this.ctx.get('tools', false) as ToolRegistry | undefined
    if (toolsSvc === undefined) throw new Error(`unknown capability tool "${name}"`)
    return toolsSvc.execute({ id: 'cap', name, arguments: args as Record<string, unknown> })
  }
}

// ───────────────────────────── m12 · AgentLoop（Loop 即插件） ─────────────────────────────

const MAX_STEPS = 12

/**
 * 与 m12 同构：AgentLoop 声明硬依赖 llm/session/prompt/tools/subagents/external，
 * 只做协调。技能 / 委派 / 文件 / 外部能力都只是同一守卫与事件路径之后的普通已注册工具，
 * Loop 不为它们设任何特殊分支（s24 核心主张）。
 */
export class AgentLoop extends Service {
  static inject = ['llm', 'session', 'prompt', 'tools', 'subagents', 'external'] as const
  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'agent')
    void config
  }
  async run(userInput: string): Promise<string> {
    const llm = this.ctx.llm as ModelService
    const session = this.ctx.session as SessionService
    const prompt = this.ctx.prompt as PromptRegistry
    const tools = this.ctx.tools as ToolRegistry

    session.append('turn/started', { turn: 1 })
    session.append('user/message', { content: userInput })

    let step = 0
    while (step < MAX_STEPS) {
      step += 1
      session.append('request/header', {
        provider: 'headless',
        model: 'mini',
        system: prompt.render().slice(0, 40),
        step,
        tools: tools.schemas().map((s) => (s.function as { name: string }).name),
      })
      const response = await llm.complete('headless', {
        model: 'mini',
        system: prompt.render(),
        messages: session.messages(),
        maxTokens: 512,
        tools: tools.schemas(),
      })
      session.append('assistant/message', { content: response.text, toolCalls: response.toolCalls, finishReason: response.finishReason })
      if (response.toolCalls.length === 0) {
        session.append('turn/ended', { turn: 1, reason: response.finishReason })
        return response.text
      }
      for (const call of response.toolCalls) {
        session.append('tool/call', { callId: call.id, name: call.name, arguments: call.arguments })
        const result = await tools.execute({ id: call.id, name: call.name, arguments: call.arguments })
        session.append('tool/result', { callId: result.callId, name: result.name, content: String(result.content), isError: result.isError })
      }
    }
    throw new Error(`agent exceeded ${MAX_STEPS} model steps`)
  }
}

// ───────────────────────────── m17 · 冷投影（teardown 后从 JSONL 重建） ─────────────────────────────

export interface ColdProjection {
  eventCount: number
  toolNames: string[]
  requestCount: number
  finalTurn: string
  status: 'completed' | 'incomplete'
}
export function coldProject(events: SessionEvent[]): ColdProjection {
  const toolNames: string[] = []
  let requestCount = 0
  let finalTurn = ''
  let completed = false
  for (const ev of events) {
    if (ev.type === 'request/header') requestCount += 1
    if (ev.type === 'tool/call') toolNames.push(String(ev.data.name))
    if (ev.type === 'turn/ended') {
      completed = true
      finalTurn = String(ev.data.reason ?? 'completed')
    }
  }
  return { eventCount: events.length, toolNames, requestCount, finalTurn, status: completed ? 'completed' : 'incomplete' }
}

// ───────────────────────────── m08 / m13 / m14 · 可观测性（事件/追踪/指标） ─────────────────────────────

export interface BusEvent {
  type: string
  payload: Record<string, unknown>
  at: number
}

// m08 事件总线聚合（注册名 'bus'，避免与 cordis 内置 ctx.events 冲突）
export class BusService extends Service {
  static readonly methods = ['on', 'recent', 'publish']
  private buffer: BusEvent[] = []
  private max = 200
  constructor(ctx: Context) {
    super(ctx, 'bus')
    ;(ctx as any).on('session/event', (ev: any) => this.publish('session/event', ev))
    ;(ctx as any).on('tool/call', (c: any) => this.publish('tool/call', c))
    ;(ctx as any).on('tool/result', (r: any) => this.publish('tool/result', r))
  }
  publish(type: string, payload: Record<string, unknown>): void {
    this.buffer.push({ type, payload, at: Date.now() })
    if (this.buffer.length > this.max) this.buffer.shift()
    ;(this.ctx as any).emit('events/bus', { type, payload })
  }
  on(type: string, handler: (e: BusEvent) => void): () => void {
    return (this.ctx as any).on('events/bus', (e: BusEvent) => {
      if (e.type === type) handler(e)
    })
  }
  recent(): BusEvent[] {
    return this.buffer
  }
}

// m14 运行期指标（订阅统一 session 事件派生计数）
export class MetricsService extends Service {
  static readonly methods = ['inc', 'snapshot']
  private counters: Record<string, number> = { toolCalls: 0, llmRequests: 0, toolErrors: 0 }
  constructor(ctx: Context) {
    super(ctx, 'metrics')
    ;(ctx as any).on('session/event', (e: any) => {
      const t = e?.type as string | undefined
      if (t === 'request/header' || t === 'request/llm') this.inc('llmRequests')
      else if (t === 'tool/result') {
        this.inc('toolCalls')
        if (e?.data?.isError) this.inc('toolErrors')
      }
    })
  }
  inc(key: string): void {
    this.counters[key] = (this.counters[key] ?? 0) + 1
  }
  snapshot(): Record<string, number> {
    return { ...this.counters }
  }
}

// m13 调用链追踪（订阅统一 session 事件派生 span）
export class TracingService extends Service {
  static readonly methods = ['startRun', 'span', 'endRun', 'report']
  private runSpans: Span[] = []
  private active: Span | null = null
  constructor(ctx: Context) {
    super(ctx, 'tracing')
    ;(ctx as any).on('session/event', (e: any) => {
      const t = e?.type as string | undefined
      if (t === 'request/header') this.span('llm-request', { step: e.data?.step })
      else if (t === 'assistant/message') this.endSpan()
      else if (t === 'tool/result') this.span('tool:' + e.data?.name, { callId: e.data?.callId })
      else if (t === 'turn/started') this.endSpan()
    })
  }
  startRun(task: string): void {
    this.runSpans = []
    this.span('run', { task })
  }
  span(name: string, meta: Record<string, unknown> = {}): void {
    if (this.active) this.endSpan()
    this.active = { name, start: Date.now(), meta }
  }
  endSpan(): void {
    if (this.active) {
      this.active.end = Date.now()
      this.runSpans.push(this.active)
      this.active = null
    }
  }
  endRun(): { name: string; ms: number; meta?: Record<string, unknown> }[] {
    this.endSpan()
    return this.runSpans.map((s) => ({ name: s.name, ms: (s.end ?? Date.now()) - s.start, meta: s.meta }))
  }
  report(): string {
    return this.endRun()
      .map((s) => `  - ${s.name} (${s.ms}ms)`)
      .join('\n')
  }
}

interface Span {
  name: string
  start: number
  end?: number
  meta?: Record<string, unknown>
}
