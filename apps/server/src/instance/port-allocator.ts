import { createServer } from 'node:net'

/**
 * 实例在宿主上发布的端口区间。
 *
 * 两端都刻意避开：
 * - **低位段**：smolvm 自己会占（实测它在 22xx 一带按顺序拿，SSH 转发之类的用途）
 * - **系统 ephemeral range**：Linux 默认 `32768–60999`、macOS `49152–65535`。
 *   落在里面的话，一个普通的出站连接就可能随机占掉我们想用的端口。
 *
 * 11000 个够用很久；真用满了要告警而不是复用 —— 复用会让两台实例抢同一个地址。
 */
export const PORT_RANGE_START = 20000
export const PORT_RANGE_END = 31999

export class PortRangeExhaustedError extends Error {
  constructor(start: number, end: number) {
    super(`宿主回环端口区间 ${start}-${end} 已用满，无法为新实例分配端口`)
    this.name = 'PortRangeExhaustedError'
  }
}

export interface PortAllocatorDeps {
  /** DB 里已分配的端口（`instance.hostPort`）。 */
  takenPorts(): Promise<Set<number>>
}

/**
 * 分配一个宿主回环端口。
 *
 * **必须真探，不能只信 DB**：宿主上可能有别的进程占着某个端口，而 smolvm 遇到端口冲突
 * 是**直接拒绝启动**（`host port X is already in use by running machine 'Y'`）——
 * 把这种端口分出去，等于让新实例稳定地起不来。
 *
 * 从区间低位往上找第一个「DB 里没有 且 宿主上真的空闲」的端口。
 */
export async function allocateHostPort(deps: PortAllocatorDeps): Promise<number> {
  const taken = await deps.takenPorts()
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (taken.has(port)) continue
    if (await isPortFree(port)) return port
  }
  throw new PortRangeExhaustedError(PORT_RANGE_START, PORT_RANGE_END)
}

/**
 * 端口此刻在宿主回环上是否真的空闲。
 *
 * 判定方式是**自己绑一次看看**：绑得上就是空的，`EADDRINUSE` 就是被占。
 * 绑的是 `127.0.0.1` —— 与 smolvm 发布端口用的地址一致，这样探到的结果才有意义。
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => {
      srv.close(() => resolve(true))
    })
    srv.listen({ host: '127.0.0.1', port, exclusive: true })
  })
}
