/**
 * m06 · 配置即插件树：节点数据类型与默认 profile
 *
 * 整棵"插件树"就是一份数据（NodeConfig 的嵌套数组）。
 * 没有一行代码是"手动 new 一个插件"，所有拓扑都由 profile 驱动。
 */
export interface NodeConfig {
  id: string
  kind: 'branch' | 'leaf'
  label: string
  /** 仅 branch 有：子节点，形成嵌套的"插件树" */
  children?: NodeConfig[]
}

/** 默认插件树：根分支 →（问候叶子 + 流水线分支 →（规则叶子 + 格式化叶子）） */
export const defaultProfile: NodeConfig[] = [
  {
    id: 'root', kind: 'branch', label: '系统根',
    children: [
      { id: 'greeter', kind: 'leaf', label: '问候服务' },
      {
        id: 'pipeline', kind: 'branch', label: '处理流水线',
        children: [
          { id: 'rules', kind: 'leaf', label: '规则层' },
          { id: 'formatter', kind: 'leaf', label: '格式化层' },
        ]
      }
    ]
  }
]
