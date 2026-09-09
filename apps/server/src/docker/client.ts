import Docker from 'dockerode'

/** 默认走本机 Docker socket；可用 DOCKER_SOCKET 覆盖。 */
export function createDocker(): Docker {
  const socketPath = process.env.DOCKER_SOCKET
  return socketPath ? new Docker({ socketPath }) : new Docker()
}

export function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 404
}

/** Docker 的 304：目标已经是期望状态（已停 / 已跑），不是错误。 */
export function isNotModified(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 304
}

/**
 * 拆 Docker 的多路复用帧（8 字节头 + 负载）。
 *
 * 容器没开 TTY 时，exec / attach 的流都是这个格式：`[stream, 0, 0, 0, size(4), payload]`。
 * 直接 `toString()` 会在输出里混进二进制头。
 */
export function demuxFrames(buf: Buffer): string {
  let out = ''
  let i = 0
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4)
    out += buf.subarray(i + 8, i + 8 + size).toString('utf8')
    i += 8 + size
  }
  return out
}
