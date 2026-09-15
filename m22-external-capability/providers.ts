/**
 * m22 · 外部能力接入（提供者插件）
 *
 * 三个外部能力 Provider + 一个 core Provider，全部以同一形态挂载进 ctx.external：
 *   - CoreProvider    ：进程内函数，无连接（证明"外部能力"与"内置能力"结构同构）
 *   - McpStyleProvider：可变工具集（模拟 MCP server 的 tools/list）
 *   - WebProvider     ：真实回环 HTTP 服务器（真实跨网络边界）
 *   - LspTeachingProvider：JSON-RPC 子进程（真实跨进程边界）
 *
 * 每个 Provider 都是一个 cordis 插件：activation 时通过 ctx.effect 注册自己，
 * 插件卸载时 effect 自动撤销它贡献的所有工具。这正是 s23 的真实工程形态：
 * 一个 capability 包（如 @deepseek-ai/dsh-mcp-client）就是一个 cordis 插件实例，
 * 在 activation 中把远端工具注册到 ctx.tools。
 */

import { Context, Plugin } from '@deepseek-ai/cordis'
import type { ExternalCapabilityProvider, MountedTool } from './external.js'
import type { ExternalConfig } from './external.js'

// ───────────────────────────── 一切皆为插件：core 与 external 同构 ─────────────────────────────

/**
 * core 能力：拥有进程内函数，不拥有任何连接副作用。
 * 它和 McpStyleProvider 的唯一区别就是 listTools 里没有"连接"这一步。
 * ——这就是"一切皆为插件"的最小证据：外部/内置只是 Provider 挂载副作用不同。
 */
class CoreProvider implements ExternalCapabilityProvider {
  readonly namespace = 'core'
  listTools(): MountedTool[] {
    return [
      {
        name: 'add',
        description: 'Add two integers (core, in-process).',
        parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } } },
        execute: (args: any) => args.a + args.b,
      },
    ]
  }
  close(): void {}
}

// ───────────────────────────── MCP 风格 Provider（可变工具集） ─────────────────────────────

/**
 * 模拟一个 MCP server：工具集在运行期可变化（演示 s23 的"工具可动态换血"）。
 * 不实现完整 JSON-RPC，只暴露"可变 listTools"这一关键性质。
 */
class McpStyleProvider implements ExternalCapabilityProvider {
  readonly namespace = 'mcp'
  private committed = false
  constructor(private readonly serverName: string) {}

  listTools(): MountedTool[] {
    // 第一次同步暴露 length；之后"发现"第二个工具（模拟 server 变更）。
    const base: MountedTool[] = [
      {
        name: 'length',
        description: `Return the length of a string (mcp server ${this.serverName}).`,
        parameters: { type: 'object', properties: { s: { type: 'string' } } },
        execute: (args: any) => (args.s as string).length,
      },
    ]
    if (this.committed) {
      base.push({
        name: 'upper',
        description: `Uppercase a string (mcp server ${this.serverName}, discovered later).`,
        parameters: { type: 'object', properties: { s: { type: 'string' } } },
        execute: (args: any) => (args.s as string).toUpperCase(),
      })
    }
    return base
  }

  /** 模拟 server 工具集变化（调用后下次 listTools 会多出 upper）。 */
  commitToolChange(): void {
    this.committed = true
  }

  close(): void {}
}

// ───────────────────────────── Web Provider（真实回环 HTTP） ─────────────────────────────

import { createServer, Server } from 'node:http'
import { request as httpRequest } from 'node:http'

/**
 * 真实 Web 能力：起一个本地 HTTP 状态服务器，并通过真实 fetch/urllib 取 /status.json。
 * 真正跨过网络边界（127.0.0.1），但教学习性地只暴露一个 status 工具。
 */
class WebProvider implements ExternalCapabilityProvider {
  readonly namespace = 'web'
  private server?: Server
  private readonly baseUrl: string
  private readonly path: string

  constructor(cfg: { baseUrl?: string; path?: string } = {}) {
    this.baseUrl = cfg.baseUrl ?? 'http://127.0.0.1:8765'
    this.path = cfg.path ?? '/status.json'
  }

  async start(): Promise<void> {
    const payload = JSON.stringify({ ok: true, service: 'demo-status', uptime: 42 })
    this.server = createServer((req, res) => {
      if (req.url === this.path) {
        res.setHeader('content-type', 'application/json')
        res.end(payload)
      } else {
        res.statusCode = 404
        res.end('not found')
      }
    })
    this.server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') return // 端口已被占用则复用
      throw err
    })
    await new Promise<void>((resolve, reject) =>
      this.server!.listen(8765, '127.0.0.1', () => resolve()),
    )
  }

  listTools(): MountedTool[] {
    return [
      {
        name: 'status',
        description: 'Fetch the demo service status over HTTP (real network boundary).',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const url = `${this.baseUrl}${this.path}`
          return await new Promise<unknown>((resolve, reject) => {
            const req = httpRequest(url, res => {
              let body = ''
              res.on('data', c => (body += c))
              res.on('end', () => resolve(JSON.parse(body)))
            })
            req.on('error', reject)
            req.end()
          })
        },
      },
    ]
  }

  close(): void {
    this.server?.close()
  }
}

// ───────────────────────────── LSP 风格 Provider（JSON-RPC 子进程） ─────────────────────────────

import { spawn, ChildProcess } from 'node:child_process'

/**
 * 教学版 LSP 能力：起一个 JSON-RPC 子进程（stdin/stdout 行协议），
 * 演示"真实跨进程边界"。只实现 workspace/symbol 的一个子集。
 * 生产互操作性请用真实 @deepseek-ai/dsh-lsp。
 */
class LspTeachingProvider implements ExternalCapabilityProvider {
  readonly namespace = 'lsp'
  private child?: ChildProcess
  private seq = 0
  private readonly command: string
  private readonly args: string[]

  constructor(cfg: { command?: string; args?: string[] } = {}) {
    this.command = cfg.command ?? 'node'
    this.args = cfg.args ?? ['./lsp-server.js']
  }

  async start(): Promise<void> {
    this.child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'inherit'] })
  }

  private rpc<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.seq
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise<T>((resolve, reject) => {
      if (!this.child) return reject(new Error('lsp child not started'))
      const onData = (chunk: Buffer) => {
        const line = chunk.toString().trim()
        if (!line) return
        const res = JSON.parse(line)
        if (res.id === id) {
          this.child!.stdout!.off('data', onData)
          resolve(res.result as T)
        }
      }
      this.child.stdout!.on('data', onData)
      this.child.stdin!.write(msg + '\n')
    })
  }

  listTools(): MountedTool[] {
    return [
      {
        name: 'symbol',
        description: 'Find workspace symbols via the language server (JSON-RPC subprocess).',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        execute: async (args: any) => this.rpc('workspace/symbol', { query: args.query }),
      },
    ]
  }

  close(): void {
    this.child?.kill()
  }
}

// ───────────────────────────── Provider 插件（挂在 ctx.external） ─────────────────────────────

/**
 * 把以上 Provider 注册进 ctx.external。每个都是独立插件：
 * activation（ctx.effect）注册 → 卸载自动撤销其工具。core 与 external 走同一条路径。
 */
const providersPlugin = {
  name: 'external-providers',
  inject: ['external'],
  async apply(ctx: Context, config: ExternalConfig) {
  // 1) core 能力：无连接，直接注册。
  ctx.effect(() => {
    ctx.external.registerProvider('core', new CoreProvider())
    return () => ctx.external.unregisterProvider('core')
  })

  // 2) mcp 风格能力：模拟可变工具集。
  ctx.effect(() => {
    const p = new McpStyleProvider(config.server?.name ?? 'local-demo')
    ctx.external.registerProvider('mcp', p)
    // 演示"工具换血"：6 秒后提交 server 工具集变化，下次同步多出 upper。
    const timer = setTimeout(() => p.commitToolChange(), 0)
    return () => {
      clearTimeout(timer)
      ctx.external.unregisterProvider('mcp')
    }
  })

  // 3) web 能力：真实回环 HTTP 服务器（effect 内 await 启动，确保就绪后注册）。
  ctx.effect(async () => {
    const p = new WebProvider(config.web)
    await p.start()
    ctx.external.registerProvider('web', p)
    return () => {
      p.close()
      ctx.external.unregisterProvider('web')
    }
  })

  // 4) lsp 能力：真实 JSON-RPC 子进程（effect 内 await 启动，确保就绪后注册）。
  ctx.effect(async () => {
    const p = new LspTeachingProvider(config.lsp)
    await p.start()
    ctx.external.registerProvider('lsp', p)
    return () => {
      p.close()
      ctx.external.unregisterProvider('lsp')
    }
  })
  },
}

export default providersPlugin
