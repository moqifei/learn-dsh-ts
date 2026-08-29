/**
 * registry：稳定 id → fiber 的目录（模块级单例）。
 *
 * 为什么用"模块级 Map"而不是 Cordis 的 service？
 * 因为我们要在节点 apply 之间、以及 Loader 的 reconcile 里反复按 id 定位 fiber，
 * 而这要求 fiber 在"依赖图稳定后"就可被读取。若把目录做成 service，
 * 在 apply 内部动态注册会触发依赖图变化（Cordis v4 要求 inject 才能读），徒增抖动。
 * 直接用一个普通 Map 单例，所有模块 import 即用，确定、无副作用。
 */
const fibers = new Map<string, any>()

export function mount(id: string, fiber: any) {
  fibers.set(id, fiber)
}

export function get(id: string): any {
  return fibers.get(id)
}

export function list(): string[] {
  return [...fibers.keys()]
}

export function drop(id: string) {
  fibers.delete(id)
}
