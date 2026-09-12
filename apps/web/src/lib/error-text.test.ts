import { describe, expect, it } from 'vitest'
import { ApiError } from './api.js'
import { errorTextOf } from './error-text.js'

describe('errorTextOf', () => {
  it('优先用服务端文案 —— 「已用 200 MB，不能缩到 128 MB」比「操作失败」有用得多', () => {
    expect(errorTextOf(new ApiError('已用 200 MB，不能缩到 128 MB', 400), '操作失败')).toBe(
      '已用 200 MB，不能缩到 128 MB',
    )
  })

  it('不是 ApiError 才回落（比如 fetch 本身挂了）', () => {
    expect(errorTextOf(new TypeError('Failed to fetch'), '操作失败')).toBe('操作失败')
  })

  it('没有错误时返回 null —— 调用方据此决定要不要渲染那一行', () => {
    expect(errorTextOf(null, '操作失败')).toBeNull()
    expect(errorTextOf(undefined, '操作失败')).toBeNull()
  })
})
