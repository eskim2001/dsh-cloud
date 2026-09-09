import { PassThrough, type Readable, type Writable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

/** 心跳间隔。Traefik 的默认空闲超时比这长，够用。 */
const HEARTBEAT_MS = 15_000

export const LogsQuerySchema = z.object({
  /** 先补多少行历史，之后跟着流。 */
  tail: z.coerce.number().int().positive().max(1000).default(200),
})

export interface LogStreamOptions {
  /** 从末尾取多少行历史。 */
  tail: number
}

/**
 * 把容器日志以 SSE 推给浏览器。
 *
 * 几个必须做对的地方：
 * - **鉴权先于 hijack**：hijack 之后 Fastify 的错误处理和响应生命周期都失效了，
 *   所以拿不到日志流时要在 hijack 之前用正常 reply 返回错误；
 * - **用 `demuxStream` 拆帧**：容器没开 TTY 时日志流是 8 字节头 + 负载的复用格式，
 *   而且帧会跨 chunk 边界——`demuxExecStream` 那种按整包拼的做法在这里是错的；
 * - **按行发事件**：SSE 每条事件里的多行要逐行加 `data:` 前缀，直接把 chunk 丢出去
 *   会在 chunk 边界处凭空多出换行；
 * - **`x-accel-buffering: no`**：否则 Traefik 会攒够一块才吐，日志就"不动"了；
 * - 客户端断开（`close`）必须销毁 docker 流和心跳，否则连接泄漏。
 */
export async function streamContainerLogs(
  req: FastifyRequest,
  reply: FastifyReply,
  containerId: string,
  opts: LogStreamOptions,
  openLogs: (containerId: string, opts: LogStreamOptions) => Promise<Readable>,
  demux: (raw: Readable, out: Writable, err: Writable) => void,
): Promise<void> {
  let raw: Readable
  try {
    raw = await openLogs(containerId, opts)
  } catch (err) {
    await reply.code(502).send({ error: `无法读取日志：${messageOf(err)}` })
    return
  }

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

  const out = new PassThrough()
  demux(raw, out, out)

  let buffered = ''
  out.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    const lines = buffered.split('\n')
    // 最后一段可能是不完整的行，留到下一块
    buffered = lines.pop() ?? ''
    for (const line of lines) send('log', line)
  })

  out.on('end', () => {
    if (buffered !== '') send('log', buffered)
    send('end', '')
    cleanup()
    res.end()
  })

  out.on('error', (err: Error) => {
    send('error', messageOf(err))
    cleanup()
    res.end()
  })

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, HEARTBEAT_MS)

  let cleaned = false
  function cleanup(): void {
    if (cleaned) return
    cleaned = true
    clearInterval(heartbeat)
    raw.destroy()
    out.destroy()
  }

  req.raw.on('close', cleanup)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
