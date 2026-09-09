import { describe, expect, it } from 'vitest'
import { parseStats, type DockerStatsSample } from './container-stats.js'

/** 真实 daemon 返回的形状（cgroup v2，截取用到的字段）。 */
function sample(over: Partial<DockerStatsSample> = {}): DockerStatsSample {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 2_967_768_000 },
      system_cpu_usage: 1_980_825_770_000_000,
      online_cpus: 8,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 2_962_895_000 },
      system_cpu_usage: 1_980_817_290_000_000,
    },
    memory_stats: {
      usage: 215_482_368,
      stats: { inactive_file: 8192 },
    },
    ...over,
  }
}

describe('parseStats', () => {
  it('按两帧差值算 CPU%，乘核数', () => {
    const usage = parseStats(sample())
    // (4_873_000 / 8_480_000_000) * 8 * 100 ≈ 0.46%
    expect(usage?.cpuPercent).toBeCloseTo(0.46, 1)
    // (215_482_368 - 8192) / 1024² ≈ 205 MiB
    expect(usage?.memMb).toBe(205)
  })

  it('首帧（system 没走）→ undefined，不记假的 0', () => {
    const usage = parseStats(
      sample({
        precpu_stats: {
          cpu_usage: { total_usage: 2_962_895_000 },
          system_cpu_usage: 1_980_825_770_000_000,
        },
      }),
    )
    expect(usage).toBeUndefined()
  })

  it('缺 online_cpus 时退化成 1 核，不是 NaN', () => {
    const usage = parseStats(
      sample({
        cpu_stats: {
          cpu_usage: { total_usage: 2_967_768_000 },
          system_cpu_usage: 1_980_825_770_000_000,
        },
      }),
    )
    expect(usage?.cpuPercent).toBeCloseTo(0.057, 2)
  })

  it('没有 memory_stats → undefined', () => {
    const raw = sample()
    delete raw.memory_stats
    expect(parseStats(raw)).toBeUndefined()
  })

  it('cgroup v1 的 cache 也减掉', () => {
    const usage = parseStats(
      sample({ memory_stats: { usage: 215_482_368, stats: { cache: 104_857_600 } } }),
    )
    expect(usage?.memMb).toBe(106)
  })
})
