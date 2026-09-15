// Teaching JSON-RPC subprocess for the LSP external capability (m23).
// Real harness uses a full language server; this stub just proves the
// subprocess boundary works and tools forward into it.
process.stderr.write('[lsp-server] teaching subprocess started\n')
process.on('message', (msg) => {
  process.send?.({ jsonrpc: '2.0', id: msg?.id ?? 1, result: { symbols: ['Capability'] } })
})
process.stdin.resume()
