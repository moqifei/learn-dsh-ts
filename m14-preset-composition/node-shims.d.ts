// 最小 node 内置模块类型声明，仅为 tsc 通过（运行时不需，node 原生支持）。
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string
  export function existsSync(path: string): boolean
  export function writeFileSync(path: string, data: string, encoding?: string): void
  export function unlinkSync(path: string): void
}
declare module 'node:path' {
  export function join(...parts: string[]): string
}
