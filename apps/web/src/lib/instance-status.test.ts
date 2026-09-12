import { describe, expect, it } from 'vitest'
import {
  DISK_ATTENTION_RATIO,
  IDLE_POLL_MS,
  IN_FLIGHT_POLL_MS,
  canOpen,
  instanceRefetchInterval,
  isTransitioning,
  listRefetchInterval,
  needsAttention,
} from './instance-status.js'

/**
 * 这些判定**错一次就是用户可见的 bug**，所以钉住：
 * - 「能不能打开」错了 → 点过去吃 502；
 * - 轮询节奏错了 → 状态永远停在旧值（crash-loop 时列表还写「运行中」）；
 * - 「快满了」错了 → 假警报，或者真满了没人管。
 */

describe('状态判定', () => {
  it('只有编排在途的状态算「在变」', () => {
    expect(isTransitioning('provisioning')).toBe(true)
    expect(isTransitioning('removing')).toBe(true)
    expect(isTransitioning('running')).toBe(false)
    // stopped / error 都已经落定（虽然「不好」，但不会自己再变）
    expect(isTransitioning('stopped')).toBe(false)
    expect(isTransitioning('error')).toBe(false)
  })

  it('只有 running 能打开', () => {
    expect(canOpen('running')).toBe(true)
    for (const s of ['provisioning', 'removing', 'stopped', 'error', 'restarting']) {
      expect(canOpen(s)).toBe(false)
    }
  })
})

describe('「需要注意」', () => {
  const base = { status: 'running', diskUsedMb: 100, diskMb: 10_000, diskEnforced: true }

  it('状态不对就要注意', () => {
    expect(needsAttention({ ...base, status: 'error' })).toBe(true)
    expect(needsAttention({ ...base, status: 'restarting' })).toBe(true)
    expect(needsAttention(base)).toBe(false)
  })

  it('磁盘到阈值才算，且用 >= 而不是 >', () => {
    const justBelow = base.diskMb * DISK_ATTENTION_RATIO - 1
    expect(needsAttention({ ...base, diskUsedMb: justBelow })).toBe(false)
    expect(needsAttention({ ...base, diskUsedMb: base.diskMb * DISK_ATTENTION_RATIO })).toBe(true)
  })

  it('配额没生效时永远不算「快满」—— 那时 diskMb 只是声明值', () => {
    // 这是关键回归：开发机内核不支持配额，拿声明值算比例会造出假警报
    expect(needsAttention({ ...base, diskUsedMb: 9_999, diskEnforced: false })).toBe(false)
  })

  it('读不到用量、或声明容量为 0，都不算', () => {
    expect(needsAttention({ ...base, diskUsedMb: undefined })).toBe(false)
    expect(needsAttention({ ...base, diskMb: 0, diskUsedMb: 0 })).toBe(false)
  })
})

describe('轮询节奏', () => {
  it('拿不到数据就不轮询', () => {
    expect(instanceRefetchInterval(undefined)).toBe(false)
    expect(listRefetchInterval(undefined)).toBe(false)
  })

  it('在途按快节奏跟', () => {
    expect(instanceRefetchInterval({ status: 'provisioning' })).toBe(IN_FLIGHT_POLL_MS)
    expect(listRefetchInterval([{ status: 'running' }, { status: 'removing' }])).toBe(
      IN_FLIGHT_POLL_MS,
    )
  })

  it('落定之后也**不能停**：状态是查询时现算的，crash-loop / 外部停掉都会漂', () => {
    expect(instanceRefetchInterval({ status: 'running' })).toBe(IDLE_POLL_MS)
    expect(listRefetchInterval([{ status: 'running' }])).toBe(IDLE_POLL_MS)
    expect(listRefetchInterval([])).toBe(IDLE_POLL_MS)
  })
})
