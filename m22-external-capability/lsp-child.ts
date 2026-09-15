// lsp-child.ts — 教学级语言服务子进程
// 从 stdin 读 JSON 请求，向 stdout 写 JSON 响应（换行分隔）。
// 真实进程边界：父进程通过 spawn 启动本文件，"lsp__symbol" 查询跨越进程边界。

interface Req {
  id: number
  method: string
  params: { query: string }
}

const SYMBOLS: Record<string, { name: string; file: string; line: number; kind: string }> = {
  GoalLoop: { name: 'GoalLoop', file: 'agent.py', line: 41, kind: 'class' },
  Worker: { name: 'Worker', file: 'worker.ts', line: 12, kind: 'interface' },
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  for (const rawLine of chunk.split('\n').filter(Boolean)) {
    const req: Req = JSON.parse(rawLine)
    if (req.method === 'workspace/symbol') {
      const hit = SYMBOLS[req.params.query]
      const resp = hit
        ? { id: req.id, result: hit }
        : { id: req.id, error: `symbol not found: ${req.params.query}` }
      process.stdout.write(JSON.stringify(resp) + '\n')
    }
  }
})
