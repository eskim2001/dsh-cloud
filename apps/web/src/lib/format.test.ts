import { describe, expect, it } from 'vitest'
import { formatMb, hostOf } from './format.js'

describe('formatMb', () => {
  it('不到 1 GB 用 MB（四舍五入）', () => {
    expect(formatMb(512)).toBe('512 MB')
    expect(formatMb(268.6)).toBe('269 MB')
  })

  it('整 GB 不带小数，非整 GB 保留一位', () => {
    expect(formatMb(1024)).toBe('1 GB')
    expect(formatMb(10_240)).toBe('10 GB')
    expect(formatMb(1536)).toBe('1.5 GB')
  })
})

describe('hostOf', () => {
  it('从入口 URL 里只取主机名 —— 那条 URL 带的是一次性 token，贴出去没用还碍眼', () => {
    expect(hostOf('https://telegram.lvh.me/?token=abc123')).toBe('telegram.lvh.me')
    expect(hostOf('https://alice.app.dsh.test/')).toBe('alice.app.dsh.test')
  })

  it('不是 URL 就原样返回（宁可显示原值，也不抛）', () => {
    expect(hostOf('telegram.lvh.me')).toBe('telegram.lvh.me')
    expect(hostOf('')).toBe('')
  })
})
