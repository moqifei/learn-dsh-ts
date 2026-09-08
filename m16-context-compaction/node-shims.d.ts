// 无 @types/node 时的最小 node 类型声明（教学用，和 m14/m15 同风格）
declare module 'node:fs' {
  export function readFileSync(path: string, encoding?: string): string
  export function writeFileSync(path: string, data: string): void
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void
  export function readdirSync(
    path: string,
    opts?: { withFileTypes?: boolean },
  ): Array<{ name: string; isDirectory(): boolean }>
  export interface FSWatcher {
    close(): void
  }
  export function watch(
    path: string,
    opts: { recursive?: boolean },
    listener?: (event: string, filename: string | null) => void,
  ): FSWatcher
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
}

declare module 'node:os' {
  export function tmpdir(): string
}

declare var process: {
  exit(code?: number): never
  [key: string]: any
}
