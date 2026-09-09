import type { Readable } from 'node:stream'

/**
 * 消费 `docker pull` 的进度流（D23）。
 *
 * 两个坑：
 * - 这条流是**逐行 JSON**，不是容器日志那种 8 字节多路复用帧——所以 `demuxFrames` 不能用，
 *   它会把前 4 字节当长度、切出错位负载。
 * - **失败是 HTTP 200 + 流内 `{"error":…}`**，不会走流的 `'error'` 事件；不解析就当成成功。
 */
export class ImagePullError extends Error {}

/** 把一行 JSON 渲染成人能读的进度文本；返回 undefined 表示这行没内容可显示。 */
export function pullLineText(line: string): string | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined

  let parsed: { status?: string; id?: string; progress?: string; error?: string }
  try {
    parsed = JSON.parse(trimmed) as typeof parsed
  } catch {
    // 不是 JSON（Docker 偶尔混进普通文本），原样显示
    return trimmed
  }

  if (parsed.error !== undefined) throw new ImagePullError(parsed.error)
  const parts = [parsed.status, parsed.id, parsed.progress].filter(
    (p): p is string => p !== undefined && p !== '',
  )
  return parts.length === 0 ? undefined : parts.join(' ')
}

/** 读完整条流。任何流内错误都以 `ImagePullError` 抛出。 */
export async function consumeImagePull(
  stream: Readable,
  onText: (text: string) => void,
): Promise<void> {
  let buffered = ''
  for await (const chunk of stream) {
    buffered += (chunk as Buffer).toString('utf8')
    const lines = buffered.split('\n')
    // 最后一段可能是不完整的行，留到下一块
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      const text = pullLineText(line)
      if (text !== undefined) onText(text)
    }
  }
  const tail = pullLineText(buffered)
  if (tail !== undefined) onText(tail)
}
