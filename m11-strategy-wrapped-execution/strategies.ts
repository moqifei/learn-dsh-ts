/**
 * m11 · 策略包裹执行 · 策略插件
 * ---------------------------------------------------------------------------
 * 真实工程对照：deepseek-harness `packages/core/tools` 的 default strategies
 * （拦截 / 超时 / 重试 / 错误标准化…）。真实 `ToolRuntime` 自身只搭"三层
 * waterfall 骨架"，具体策略由独立插件通过 `ctx.on('tools/...', ...)` 注册。
 *
 * 课程版同样把每条策略写成一个 ctx.on 监听器：
 *   - 拦截策略（pre-execute）：对危险调用返回 null ⇒ 短路
 *   - 超时策略（execute/around）：包裹 next，超时抛错
 *   - 错误标准化策略（post-execute）：把异常转成结构化 ToolResult.error
 *
 * 每条策略的注册返回一个 disposer（ctx.on 返回值）。卸载某个策略插件 ⇒
 * 该策略从瀑布链中消失 ⇒ 执行行为随之改变。这正是"策略是插件、执行是被
 * 包裹的管线"。
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from './runtime.ts'
import type { ToolCall } from './runtime.ts'

// 导出"策略插件的 disposer"，供 runner 演示"热卸载某条策略"
export let timeoutDisposer: (() => void) | undefined
export let guardDisposer: (() => void) | undefined

export const strategies = {
  name: 'builtin-strategies',
  inject: ['executor'],
  apply(ctx: Context): void {
    const runtime = ctx.executor as ToolRuntime

    // ① 拦截策略（pre-execute）：拒绝删除类工具
    //    cordis waterfall 的语义：listener 返回的值即"向下游传递的值"，
    //    不调用 next() 即终止链（拦截/替换）；返回 next() 即继续链。
    //    注意：next() 会忽略实参，直接用原始 payload 调用下游，因此"替换"
    //    必须通过返回值完成，而非 next(wrapped)。
    guardDisposer = ctx.on('tools/pre-execute', (call: ToolCall, next: () => ToolCall) => {
      if (call.name.startsWith('danger/')) {
        runtime.markInterceptor('guard')
        console.log(`    🛡️  拦截策略：拒绝危险调用 ${call.name}`)
        return null // 返回 null ⇒ 短路，不执行
      }
      return next() // 放行，继续链
    })

    // ② 超时策略（execute/around）：包裹真正执行，超时抛错
    //    around 做法：返回"包裹后的 payload"（run 被包成带超时的版本）。
    timeoutDisposer = ctx.on(
      'tools/execute',
      (
        payload: { call: ToolCall; run: () => Promise<unknown> },
        next: () => typeof payload,
      ) => {
        const wrapped: typeof payload = {
          ...payload,
          run: async () => {
            const timeoutMs = 50
            const timer = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
            )
            return Promise.race([payload.run(), timer])
          },
        }
        // 由于 next() 忽略实参，这里直接返回包裹后的 payload 作为最终结果，
        // 等同"around 包裹了真正执行"。
        return wrapped
      },
    )

    // ③ 错误标准化策略（post-execute）：把异常转成结构化 error
    ctx.on(
      'tools/post-execute',
      (
        payload: { call: ToolCall; result?: unknown; error?: unknown },
        next: () => typeof payload,
      ) => {
        if (payload.error) {
          const err = payload.error as Error
          console.log(`    ⚠️  后处理策略：标准化错误 → ${err.message}`)
        } else {
          console.log(`    ✅  后处理策略：结果已标准化`)
        }
        // next() 忽略实参、直接返回下游（默认 next）结果；这里仅需"继续链"。
        return next()
      },
    )
  },
}

export default strategies
