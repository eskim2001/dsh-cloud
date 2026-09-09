import { describe, expect, it } from 'vitest'
import { gateToken } from './gate-token.js'

describe('gateToken', () => {
  it('确定性：同 slug 同密钥 → 同值', () => {
    expect(gateToken('alice', 's')).toBe(gateToken('alice', 's'))
  })

  it('实例维度：换 slug 就不同', () => {
    expect(gateToken('alice', 's')).not.toBe(gateToken('bob', 's'))
  })

  it('密钥维度：换密钥就不同（轮换后旧容器会 403，是预期行为）', () => {
    expect(gateToken('alice', 's1')).not.toBe(gateToken('alice', 's2'))
  })

  it('分隔符防混淆：slug 边界不能靠拼接撞车', () => {
    // "a" + "bc" 与 "ab" + "c" 若直接拼 slug 会撞；带前缀分隔符则不会
    expect(gateToken('abc', 's')).not.toBe(gateToken('ab', 's') + gateToken('c', 's'))
  })

  it('base64url 字符集（可安全放进 HTTP header）', () => {
    expect(gateToken('alice', 's')).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
