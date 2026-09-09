/**
 * Docker stats 里我们真正要用的字段。只声明用到的，避免把 dockerode 的
 * 大类型拖进测试——`parseStats` 是纯函数，喂假数据就能测。
 */
export interface DockerStatsSample {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number }
    system_cpu_usage?: number
    /** cgroup 视角的核数。缺了就退化成 1。 */
    online_cpus?: number
  }
  precpu_stats?: {
    cpu_usage?: { total_usage?: number }
    system_cpu_usage?: number
  }
  memory_stats?: {
    usage?: number
    stats?: { cache?: number; inactive_file?: number }
  }
}

export interface ContainerUsage {
  /** 100 = 用满一个核；多核实例可以超过 100。 */
  cpuPercent: number
  memMb: number
}

const BYTES_PER_MB = 1024 * 1024

/**
 * 把一帧 stats 算成 CPU% / 内存。
 *
 * **算不出来就返回 `undefined`，不要记 0**：容器刚起来的首帧没有可比的前一帧，
 * 记成 0 会在曲线上留一个假的「没在用」点。
 */
export function parseStats(raw: DockerStatsSample): ContainerUsage | undefined {
  const cpuPercent = cpuPercentOf(raw)
  const memMb = memoryMbOf(raw)
  if (cpuPercent === undefined || memMb === undefined) return undefined
  return { cpuPercent, memMb }
}

function cpuPercentOf(raw: DockerStatsSample): number | undefined {
  const cpu = raw.cpu_stats?.cpu_usage?.total_usage
  const prevCpu = raw.precpu_stats?.cpu_usage?.total_usage
  const sys = raw.cpu_stats?.system_cpu_usage
  const prevSys = raw.precpu_stats?.system_cpu_usage
  if (cpu === undefined || prevCpu === undefined || sys === undefined || prevSys === undefined) {
    return undefined
  }

  const cpuDelta = cpu - prevCpu
  const sysDelta = sys - prevSys
  // 首帧 / 计数重置：system 没走或倒退，这一帧没有意义
  if (sysDelta <= 0 || cpuDelta < 0) return undefined

  const cores = raw.cpu_stats?.online_cpus ?? 1
  return (cpuDelta / sysDelta) * cores * 100
}

function memoryMbOf(raw: DockerStatsSample): number | undefined {
  const usage = raw.memory_stats?.usage
  if (usage === undefined) return undefined
  // cgroup v2 叫 inactive_file，v1 叫 cache——都是可回收页缓存，不算真实占用
  const reclaimable = raw.memory_stats?.stats?.inactive_file ?? raw.memory_stats?.stats?.cache ?? 0
  return Math.max(0, Math.round((usage - reclaimable) / BYTES_PER_MB))
}
