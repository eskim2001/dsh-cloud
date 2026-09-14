import { describe, expect, it } from 'vitest'
import { authBaseUrl, createAuth } from './auth.js'
import { createDb } from './db/client.js'
import { loadEnv, type Env } from './env.js'

/**
 * 引导态（还没配域名）下的认证。
 *
 * 真机上踩过一次：`CONSOLE_DOMAIN` 为空时 baseURL 拼成 `"https://"`，better-auth 建上下文
 * 直接抛 `Invalid base URL: https://` —— 死的是 **`scripts/seed.ts`**（它自己也建了一个
 * auth 实例，而且引导态下它恰恰要跑）。所以这两条盯的是"空域名不许拼出裸协议"。
 */
function env(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    DATABASE_URL: 'postgres://localhost:5432/x',
    BASE_DOMAIN: '',
    CONSOLE_DOMAIN: '',
    PLATFORM_SECRET: 'p'.repeat(32),
    BETTER_AUTH_SECRET: 'b'.repeat(32),
    ...overrides,
  })
}

describe('引导态下的认证', () => {
  it('域名空 → baseURL 兜到占位值，绝不出现裸协议', () => {
    expect(authBaseUrl(env())).toBe('http://127.0.0.1:3000')
    // 对照：配好域名就是真的控制台地址
    expect(
      authBaseUrl(env({ BASE_DOMAIN: 'app.example.com', CONSOLE_DOMAIN: 'console.app.example.com' })),
    ).toBe('https://console.app.example.com')
  })

  it('**建上下文不抛** —— 真机上 seed 就死在这一步', async () => {
    // 连接是懒的，这里不会真的碰数据库；要的只是走完 better-auth 的上下文初始化
    const { db } = createDb('postgres://localhost:5432/nonexistent')
    const auth = createAuth(env(), db)

    // 不抛就算过（未登录时返回 null/undefined 都行）
    await auth.api.getSession({ headers: new Headers() })
  })
})
