import { Context } from '@deepseek-ai/cordis'
import { defaultProfile, NodeConfig } from './profile'
import { Loader } from './loader'

export const name = 'runner'
export const inject: string[] = [] // runner 是入口，不需要前置服务
export async function apply(ctx: Context) {
  // 用根 context 挂载所有节点（平铺），避免"在 apply 内挂子触发自身重启"
  const root = (ctx as any).root ?? ctx
  const loader = new Loader(root)

  // —— 阶段 1：首次挂载整棵插件树 ——
  console.log('\n=== 阶段1：挂载默认插件树 ===')
  await loader.mount(defaultProfile)
  await new Promise((r) => setTimeout(r, 50)) // 等 effect 全部 settled
  console.log('已挂载节点：', listIds())

  // —— 阶段 2：HMR① 改叶子 formatter 的 label（外科手术式热更） ——
  console.log('\n=== 阶段2：HMR① 改叶子 formatter 的 label（只动它一个）===')
  const p2: NodeConfig[] = clone(defaultProfile)
  find(p2, 'formatter').label = '格式化层 v2'
  await loader.reconcile(p2)
  await new Promise((r) => setTimeout(r, 50))

  // —— 阶段 3：HMR② 禁用叶子 rules（从树中移除 → dispose） ——
  console.log('\n=== 阶段3：HMR② 禁用叶子 rules（从 profile 删除它）===')
  const p3: NodeConfig[] = clone(defaultProfile)
  const pipeline3 = find(p3, 'pipeline')
  pipeline3.children = pipeline3.children!.filter((c) => c.id !== 'rules')
  await loader.reconcile(p3)
  await new Promise((r) => setTimeout(r, 50))

  // —— 阶段 4：HMR③ 改分支 pipeline 的 label（只重启分支自身，子树不受影响） ——
  console.log('\n=== 阶段4：HMR③ 改分支 pipeline 的 label（仅分支自身重启）===')
  const p4real: NodeConfig[] = clone(defaultProfile)
  find(p4real, 'pipeline').label = '处理流水线 v2'
  await loader.reconcile(p4real)
  await new Promise((r) => setTimeout(r, 50))

  console.log('\n=== 收尾：所有节点已通过稳定 id 完成结构化 HMR，无整树重建 ===')
  console.log('当前节点：', listIds())

  // 给足时间让所有 effect/cleanup 打印完，再退出
  await new Promise((r) => setTimeout(r, 100))
  process.exit(0)
}

// —— 小工具 ——
import { list } from './registry'
function listIds() {
  return list().join(', ')
}
function clone(p: NodeConfig[]): NodeConfig[] {
  return JSON.parse(JSON.stringify(p))
}
function find(p: NodeConfig[], id: string): NodeConfig {
  for (const n of p) {
    if (n.id === id) return n
    if (n.children) {
      const r = find(n.children, id)
      if (r) return r
    }
  }
  throw new Error('node not found: ' + id)
}
