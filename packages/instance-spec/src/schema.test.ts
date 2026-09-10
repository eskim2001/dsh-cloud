import { describe, expect, it } from 'vitest'
import { InstanceSlugSchema, RESERVED_SLUGS, isReservedSlug } from './schema.js'

describe('InstanceSlugSchema', () => {
  it('只做形状校验：保留字**能**过（存量记录要能启停 / 删除）', () => {
    for (const slug of ['console', 'platform', 'www', 'test']) {
      expect(InstanceSlugSchema.safeParse(slug).success, slug).toBe(true)
    }
  })

  it('形状非法的输入一律被拒', () => {
    for (const slug of ['ab', 'Alice', '-foo', 'foo-', 'xn--abc', 'a'.repeat(33), 'a_b']) {
      expect(InstanceSlugSchema.safeParse(slug).success, slug).toBe(false)
    }
  })

  it('普通词放行', () => {
    for (const slug of ['alice', 'my-project', 'team2']) {
      expect(InstanceSlugSchema.safeParse(slug).success, slug).toBe(true)
    }
  })
})

describe('RESERVED_SLUGS', () => {
  it('表里每一项都是**够长且形状合法**的 slug（否则是挡不住任何输入的死条目）', () => {
    // 长度不足 3 或含非法字符的词，用户本来就打不进来——留在表里只会误导后来者
    for (const slug of RESERVED_SLUGS) {
      expect(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug), slug).toBe(true)
      expect(slug.length, slug).toBeGreaterThanOrEqual(3)
    }
  })

  it('isReservedSlug 认得表里的词，不误伤普通词', () => {
    expect(isReservedSlug('console')).toBe(true)
    expect(isReservedSlug('grafana')).toBe(true)
    expect(isReservedSlug('alice')).toBe(false)
  })
})
