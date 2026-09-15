// 教学版 LSP 子进程：stdin/stdout 行协议 JSON-RPC，仅实现 workspace/symbol 子集。
const symbols = [
  { name: 'CapabilityRuntime', kind: 'class', location: { uri: 'inmemory:///external.ts', range: {} } },
  { name: 'ExternalCapabilityProvider', kind: 'interface', location: { uri: 'inmemory:///external.ts', range: {} } },
]

process.stdin.on('data', (chunk) => {
  const lines = chunk.toString().split('\n').filter(Boolean)
  for (const line of lines) {
    let req
    try { req = JSON.parse(line) } catch { continue }
    if (req.method === 'workspace/symbol') {
      const q = (req.params?.query ?? '').toLowerCase()
      const result = symbols.filter(s => s.name.toLowerCase().includes(q))
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
    }
  }
})
