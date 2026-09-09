import { describe, expect, it } from 'vitest'
import { compareImageRefs, imageTag, isReleaseTag } from './image-catalog.js'

describe('imageTag', () => {
  it('取 tag，不带 digest / 端口干扰', () => {
    expect(imageTag('ghcr.io/eskim2001/dsh-instance:0.1.2-rc.1_2')).toBe('0.1.2-rc.1_2')
    expect(imageTag('registry:5000/dsh-instance:0.1.0_1')).toBe('0.1.0_1')
    expect(imageTag('dsh-instance@sha256:abc')).toBeUndefined()
    expect(imageTag('dsh-instance')).toBeUndefined()
  })
})

describe('isReleaseTag', () => {
  it('认发布序列的形状', () => {
    expect(isReleaseTag('ghcr.io/eskim2001/dsh-instance:0.1.2-rc.1_2')).toBe(true)
    expect(isReleaseTag('ghcr.io/eskim2001/dsh-instance:0.1.0_1')).toBe(true)
  })

  it('挡住 :latest / 无修订号 / 修订号以 0 开头（公开仓库谁都能推）', () => {
    expect(isReleaseTag('ghcr.io/eskim2001/dsh-instance:latest')).toBe(false)
    expect(isReleaseTag('ghcr.io/eskim2001/dsh-instance:0.1.0')).toBe(false)
    expect(isReleaseTag('ghcr.io/eskim2001/dsh-instance:0.1.0_01')).toBe(false)
    expect(isReleaseTag('ghcr.io/eskim2001/dsh-instance:_1')).toBe(false)
  })
})

describe('compareImageRefs', () => {
  it('修订号按数字比：_10 在 _9 之后', () => {
    expect(
      compareImageRefs('dsh-instance:0.1.2_10', 'dsh-instance:0.1.2_9'),
    ).toBeGreaterThan(0)
  })

  it('版本号按数字段比：0.1.10 > 0.1.9', () => {
    expect(
      compareImageRefs('dsh-instance:0.1.10_1', 'dsh-instance:0.1.9_1'),
    ).toBeGreaterThan(0)
  })

  it('预发布低于同版本正式版', () => {
    expect(
      compareImageRefs('dsh-instance:0.1.2_1', 'dsh-instance:0.1.2-rc.1_1'),
    ).toBeGreaterThan(0)
  })

  it('缺段当 0：0.1 < 0.1.1', () => {
    expect(compareImageRefs('dsh-instance:0.1_1', 'dsh-instance:0.1.1_1')).toBeLessThan(0)
  })

  it('倒序排出来就是「新的在前」', () => {
    const refs = [
      'dsh-instance:0.1.2-rc.1_1',
      'dsh-instance:0.1.2-rc.1_2',
      'dsh-instance:0.1.10_1',
      'dsh-instance:0.1.9_3',
    ]
    expect([...refs].sort((a, b) => compareImageRefs(b, a))).toEqual([
      'dsh-instance:0.1.10_1',
      'dsh-instance:0.1.9_3',
      'dsh-instance:0.1.2-rc.1_2',
      'dsh-instance:0.1.2-rc.1_1',
    ])
  })
})
