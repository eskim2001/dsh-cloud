import { describe, expect, it } from 'vitest'
import {
  INVITE_TTL_HOURS,
  hashInviteToken,
  inviteExpiry,
  inviteUrl,
  newInviteToken,
} from './invitation.js'

describe('邀请 token：生成与哈希', () => {
  it('每次都不同', () => {
    const seen = new Set(Array.from({ length: 50 }, () => newInviteToken()))
    expect(seen.size).toBe(50)
  })

  it('是 URL-safe 的——直接拼进链接不需要转义', () => {
    for (let i = 0; i < 20; i++) {
      expect(newInviteToken()).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('哈希稳定，且不同 token 不撞', () => {
    const token = newInviteToken()
    expect(hashInviteToken(token)).toBe(hashInviteToken(token))
    expect(hashInviteToken(token)).not.toBe(hashInviteToken(newInviteToken()))
  })

  it('哈希与明文不同——库里不能出现明文', () => {
    const token = newInviteToken()
    const hash = hashInviteToken(token)
    expect(hash).not.toBe(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('邀请链接：地址与有效期', () => {
  it('挂在控制台域名下', () => {
    const token = newInviteToken()
    expect(inviteUrl('https', 'console.example.com', token)).toBe(
      `https://console.example.com/invite/${token}`,
    )
  })

  it('有效期是 7 天', () => {
    const from = new Date('2026-01-01T00:00:00Z')
    expect(inviteExpiry(from).getTime() - from.getTime()).toBe(INVITE_TTL_HOURS * 60 * 60 * 1000)
    expect(INVITE_TTL_HOURS).toBe(7 * 24)
  })
})
