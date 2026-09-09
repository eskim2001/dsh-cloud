import type { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { consumeImagePull } from '../instance/image-pull.js'

/** 与日志流一致。Traefik 的默认空闲超时比这长，够用。 */
const HEARTBEAT_MS = 15_000

/**
 * 把 `docker pull` 的进度以 SSE 推给浏览器（D23）。
 *
 * 约定照抄 `log-stream.ts`：**鉴权与校验先于 hijack**（hijack 之后 Fastify 的错误处理
 * 就失效了，只能自己写响应）、`x-accel-buffering: no`（否则 Traefik 攒够一块才吐，
 * 进度看着像卡死）、15 秒心跳、`close` 时销毁上游流。
 *
 * 两处差别：pull 的流是**逐行 JSON**，没有多路复用帧头，所以不 demux；而**打开流失败
 * 也走流内 `error` 事件**，不用 502——`EventSource` 读不到非 200 响应的 body，回 502
 * 的话前端只能显示一句没头没尾的「下载失败」（真实原因是「manifest 没有 arm64」之类，
 * 恰恰是最该看见的）。HTTP 状态因此恒为 200，失败信号只有 `error` 事件。
 */
export async function streamImagePull(
  req: FastifyRequest,
  reply: FastifyReply,
  openPull: () => Promise<Readable>,
): Promise<void> {
  reply.hijack()
  const res = reply.raw
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')

  const send = (event: string, data: string): void => {
    if (res.writableEnded) return
    const body = data.split('\n').map((line) => `data: ${line}`).join('\n')
    res.write(`event: ${event}\n${body}\n\n`)
  }

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, HEARTBEAT_MS)

  let cleaned = false
  let raw: Readable | undefined
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    clearInterval(heartbeat)
    raw?.destroy()
  }

  // 两个都听：`req` 的 close 在 Node 各版本语义有出入，`res` 的 close 是连接真的断了。
  // cleanup 幂等，重复调用无副作用。
  req.raw.on('close', cleanup)
  res.on('close', cleanup)

  try {
    raw = await openPull()
    // 客户端可能在打开流的这段时间里就走了——那就别再拉一个没人要的流
    if (cleaned) {
      raw.destroy()
      return
    }
    await consumeImagePull(raw, (text) => send('progress', text))
    send('end', '')
  } catch (err) {
    send('error', messageOf(err))
  } finally {
    cleanup()
    if (!res.writableEnded) res.end()
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
