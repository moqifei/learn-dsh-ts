// web-server.ts — 教学级真实本地 HTTP server
// 刻意保持最小：只服务 /status.json，返回关于服务 Atlas 的固定 JSON。
// 这是一个真实跨越 HTTP 边界的传输（不是 mock），但不含重定向/认证/缓存等生产特性。

import { createServer, Server } from 'node:http'

export const MOCK_STATUS = { codename: 'Atlas', region: 'ap-east', ok: true }

export interface RunningServer {
  port: number
  close(): void
}

export function startServer(): RunningServer {
  const server: Server = createServer((req, res) => {
    if (req.url === '/status.json') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(MOCK_STATUS))
    } else {
      res.statusCode = 404
      res.end('not found')
    }
  })
  // 监听在临时 loopback 随机端口（0 = 系统分配）
  server.listen(0, '127.0.0.1')
  const port = (server.address() as { port: number }).port
  return {
    port,
    close: () => server.close(),
  }
}
