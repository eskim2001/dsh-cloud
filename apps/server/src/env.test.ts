import { describe, expect, it } from 'vitest'
import { loadEnv, withPlatformDomains } from './env.js'

function source(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://localhost:5432/x',
    BASE_DOMAIN: 'lvh.me',
    CONSOLE_DOMAIN: 'console.lvh.me',
    PLATFORM_SECRET: 'p'.repeat(32),
    BETTER_AUTH_SECRET: 'b'.repeat(32),
    ...overrides,
  }
}

describe('CONSOLE_DOMAIN 必须是 BASE_DOMAIN 的子域', () => {
  it('严格子域放行', () => {
    expect(loadEnv(source()).CONSOLE_DOMAIN).toBe('console.lvh.me')
  })

  it('父域本身被拒——父域不当主机名用', () => {
    expect(() => loadEnv(source({ CONSOLE_DOMAIN: 'lvh.me' }))).toThrow(/子域/)
  })

  it('不在父域之下的主机名被拒', () => {
    // 后缀对、但标签边界不对（`evil-lvh.me` 不是 `lvh.me` 的子域）
    for (const consoleDomain of ['console.other.me', 'evil-lvh.me', 'notlvh.me']) {
      expect(() => loadEnv(source({ CONSOLE_DOMAIN: consoleDomain })), consoleDomain).toThrow(/子域/)
    }
  })
})

describe('域名可以整对留空（= 引导态：还没配域名）', () => {
  it('两个都空合法', () => {
    const env = loadEnv(source({ BASE_DOMAIN: '', CONSOLE_DOMAIN: '' }))
    expect([env.BASE_DOMAIN, env.CONSOLE_DOMAIN]).toEqual(['', ''])
  })

  it('压根不写域名也是引导态', () => {
    const { BASE_DOMAIN: _b, CONSOLE_DOMAIN: _c, ...rest } = source()
    const env = loadEnv(rest)
    expect([env.BASE_DOMAIN, env.CONSOLE_DOMAIN]).toEqual(['', ''])
  })

  it('**只填一个**是配置错误 —— 别让它悄悄跑成引导态', () => {
    expect(() => loadEnv(source({ CONSOLE_DOMAIN: '' }))).toThrow(/都空/)
    expect(() => loadEnv(source({ BASE_DOMAIN: '' }))).toThrow(/都空/)
  })
})

describe('withPlatformDomains：env 优先 → DB → 都没有才是引导态', () => {
  const stored = { baseDomain: 'example.com', consoleDomain: 'console.example.com' }
  const boot = loadEnv(source({ BASE_DOMAIN: '', CONSOLE_DOMAIN: '' }))

  it('env 里有 → 用 env，DB 说什么都不听', () => {
    const r = withPlatformDomains(loadEnv(source()), stored)
    expect(r.bootstrap).toBe(false)
    expect(r.env.BASE_DOMAIN).toBe('lvh.me')
  })

  it('env 空、DB 有 → 用 DB 那对', () => {
    const r = withPlatformDomains(boot, stored)
    expect(r.bootstrap).toBe(false)
    expect([r.env.BASE_DOMAIN, r.env.CONSOLE_DOMAIN]).toEqual(['example.com', 'console.example.com'])
  })

  it('都没有 → 引导态', () => {
    expect(withPlatformDomains(boot).bootstrap).toBe(true)
    expect(withPlatformDomains(boot, { baseDomain: '', consoleDomain: '' }).bootstrap).toBe(true)
  })

  it('DB 里那对不成父子 → 当没配（fail closed），不拿它拼 URL', () => {
    const r = withPlatformDomains(boot, { baseDomain: 'example.com', consoleDomain: 'console.other.com' })
    expect(r.bootstrap).toBe(true)
    expect(r.env.CONSOLE_DOMAIN).toBe('')
  })
})
