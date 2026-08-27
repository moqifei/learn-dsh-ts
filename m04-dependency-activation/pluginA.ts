import { Service, type Context } from '@deepseek-ai/cordis'

// ============================================================================
// m04 角色文件之一：链首 provider —— 提供 ctx.a
// ----------------------------------------------------------------------------
// 本文件是一个【独立插件】，由 cordis.yml 加载（位置可任意，不必在 B/C 之前）。
// 它负责：① 挂载 ServiceA 提供 a；② 用 setTimeout 演示"热替换"：
//   拆掉自己（a 消失 → B/C 回 PENDING），再挂一个同服务名 'a'、不同实现的 A2，
//   让 B/C 自动用新 a 重新激活。
// ============================================================================

// —— 新增 m04 —— 声明服务类型合并（a、b 由各自文件声明，这里只需 a）——
declare module '@deepseek-ai/cordis' {
  interface Context {
    a: ServiceA
  }
}

// —— 新增 m04 —— 链首 provider：提供 a ——
export class ServiceA extends Service {
  constructor(ctx: Context) {
    super(ctx, 'a')
  }
  whoami() {
    return 'A'
  }
}

export const name = 'provider-a'
export function apply(ctx: Context) {
  // 挂载 ServiceA（提供 a），并返回 fiber 以便后续热替换时 dispose
  const fiberA = ctx.plugin(ServiceA)
  console.log('[A] 已注册 ctx.a 服务')

  setTimeout(async () => {
    // —— 演示"热替换"：只拆链首 A，让依赖它的 B/C 自动回到 PENDING ——
    // 不 dispose B/C，它们仍是"已挂载"状态，等 a 再次出现即重新激活。
    console.log('\n--- 演示热替换：只拆链首 A，挂载 A2（同服务名不同实现）---')
    await fiberA.dispose()

    // A2：同服务名 'a'，不同实现（whoami 返回 'A2'）
    const pluginA2 = {
      name: 'provider-a2',
      apply(ctx2: Context) {
        ctx2.plugin(
          class extends ServiceA {
            whoami() {
              return 'A2'
            }
          },
        )
        console.log('[A2] 已注册 ctx.a 服务（新实现）')
      },
    }
    ctx.plugin(pluginA2) // a 就绪 → B 激活 → C 用新 a 重新激活

    setTimeout(() => {
      console.log('[provider-a] 演示结束，进程退出')
      process.exit(0)
    }, 500)
  }, 500)
}
