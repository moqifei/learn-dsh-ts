/**
 * 与提供者无关的共享词汇（internal request/response shape）。
 *
 * 这是"接缝"的两侧约定：消费者只产出/消费这些类型；
 * Provider 适配器负责把具体 SDK 的对象投影进/出这套共享词汇。
 * SDK 的类型绝不允许越过这条线泄漏给消费者。
 */

export type Role = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: Role
  content: string
}

/** 消费者发出的统一请求（不含任何 provider 专属字段） */
export interface GenerateRequest {
  /** 逻辑模型名（仅作记录/诊断，路由由 complete() 的 router 参数决定） */
  model: string
  /** 可选 system 指令 */
  system?: string
  /** 对话消息 */
  messages: ChatMessage[]
  /** 最大输出 token（默认 256） */
  maxTokens?: number
}

/** 适配器返回的统一响应（provider 专属细节已归一化） */
export interface GenerateResponse {
  /** 归一化后的文本 */
  text: string
  /** 归一化后的结束原因（如 'stop' / 'length'） */
  finishReason: string
  /** 实际服务的路由名（用于归因） */
  provider: string
}

/**
 * Provider 适配器契约：接收一个共享请求，返回一个共享响应。
 * 任何具体模型 SDK 只存在于实现了这个接口的类内部。
 */
export interface LlmAdapter {
  generate(req: GenerateRequest): Promise<GenerateResponse>
}
