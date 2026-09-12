import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { invalidateInstances, keys } from './query-keys.js'

/**
 * 这里钉住的是**一个具体的 bug**：`instances` 与 `admin/instances` 曾经是两个互不失效的缓存 ——
 * 在管理面改完配额，用户列表还是旧的；在详情页升级完镜像，舰队页没变。
 * 症状是"数据看着没更新"，而根因隔着两个文件。
 */

/** 把 invalidateQueries 的调用参数记下来（不碰网络、不碰真实数据）。 */
function spyInvalidations(qc: QueryClient) {
  const spy = vi.spyOn(qc, 'invalidateQueries')
  return () => spy.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey)
}

describe('invalidateInstances', () => {
  it('不带 id：两个列表一起失效', () => {
    const qc = new QueryClient()
    const calls = spyInvalidations(qc)

    invalidateInstances(qc)

    expect(calls()).toEqual([keys.instances, keys.adminInstances])
  })

  it('带 id：列表 + 该实例的详情/用量/镜像（管理面那份也要刷）', () => {
    const qc = new QueryClient()
    const calls = spyInvalidations(qc)

    invalidateInstances(qc, 'i-1')

    expect(calls()).toEqual([
      keys.instances,
      keys.adminInstances,
      keys.instance('i-1'),
      keys.instanceStats('i-1'),
      keys.instanceImage('i-1'),
      keys.adminInstanceImage('i-1'),
    ])
  })
})

describe('key 形状', () => {
  it('指标 key 末尾带 limit，但前缀仍是同样的两段 —— 失效才能一次覆盖所有范围', () => {
    const k = keys.instanceMetrics('i-1', 360)
    expect(k).toEqual(['instance-metrics', 'i-1', 360])
    // react-query 按前缀匹配：`['instance-metrics','i-1']` 必须命中它
    expect(k.slice(0, 2)).toEqual(keys.instanceMetrics('i-1', 120).slice(0, 2))
  })

  it('实例相关 key 都带 id，不会跨实例串缓存', () => {
    expect(keys.instance('a')).not.toEqual(keys.instance('b'))
    expect(keys.instanceImage('a')).not.toEqual(keys.adminInstanceImage('a'))
  })
})
