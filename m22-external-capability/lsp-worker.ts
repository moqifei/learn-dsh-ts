// lsp-worker.ts — 教学级真实 JSON-lines subprocess
// 启动一个独立子进程（node 运行 lsp-child.ts），通过 stdin/stdout 以换行分隔 JSON 通信。
// 这是真实进程边界：真实的 I/O、请求 ID 关联、方法分发、teardown。
// 刻意不实现完整 LSP（无 Content-Length framing / initialize 协商 / diagnostics 等）。

import { spawn, ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface SymbolResult {
  name: string
  file: string
  line: number
  kind: string
}

// 返回子进程句柄 + kill 方法，便于 querySymbol 注册 stdout 监听、provider 卸载时清理。
export interface LspChild {
  proc: ChildProcess
  kill(): void
}

// 符号索引（确定性教学数据）
const SYMBOLS: Record<string, SymbolResult> = {
  GoalLoop: { name: 'GoalLoop', file: 'agent.py', line: 41, kind: 'class' },
  Worker: { name: 'Worker', file: 'worker.ts', line: 12, kind: 'interface' },
}

export function spawnLsp(): LspChild {
  const here = dirname(fileURLToPath(import.meta.url))
  const proc = spawn(process.execPath, [join(here, 'lsp-child.ts')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  return {
    proc,
    kill: () => proc.kill(),
  }
}

// 同步请求-响应：发送一行 JSON，读回一行带相同 id 的 JSON
export function querySymbol(child: LspChild, query: string): Promise<SymbolResult> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const onData = (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const msg = JSON.parse(line)
        if (msg.id === id) {
          proc.stdout!.off('data', onData)
          if (msg.error) reject(new Error(msg.error))
          else resolve(msg.result)
        }
      }
    }
    const proc = child.proc
    proc.stdout!.on('data', onData)
    proc.stdin!.write(
      JSON.stringify({ id, method: 'workspace/symbol', params: { query } }) + '\n',
    )
  })
}
