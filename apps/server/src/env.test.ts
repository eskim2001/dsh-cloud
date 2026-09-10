import { describe, expect, it } from 'vitest'
import { loadEnv } from './env.js'

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
