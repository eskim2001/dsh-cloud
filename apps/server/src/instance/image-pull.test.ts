import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { consumeImagePull, ImagePullError, pullLineText } from './image-pull.js'

describe('pull 进度行解析', () => {
  it('status / id / progress 拼成一行', () => {
    expect(
      pullLineText(
        JSON.stringify({ status: 'Downloading', id: 'abc123', progress: '[==>   ] 1MB/10MB' }),
      ),
    ).toBe('Downloading abc123 [==>   ] 1MB/10MB')
  })

  it('只有 status 就只回 status', () => {
    expect(pullLineText(JSON.stringify({ status: 'Pulling from eskim2001/dsh-instance' }))).toBe(
      'Pulling from eskim2001/dsh-instance',
    )
  })

  it('空行 / 没有可显示字段 → undefined', () => {
    expect(pullLineText('')).toBeUndefined()
    expect(pullLineText('   ')).toBeUndefined()
    expect(pullLineText(JSON.stringify({ progressDetail: { current: 1 } }))).toBeUndefined()
  })

  it('非 JSON 行原样返回（Docker 偶尔混进纯文本）', () => {
    expect(pullLineText('Pulling from foo')).toBe('Pulling from foo')
  })

  it('流内 error 抛 ImagePullError——HTTP 200 不代表拉成功', () => {
    expect(() => pullLineText(JSON.stringify({ error: 'manifest unknown' }))).toThrow(
      ImagePullError,
    )
    expect(() => pullLineText(JSON.stringify({ error: 'manifest unknown' }))).toThrow(
      /manifest unknown/,
    )
  })
})

/** 把若干字符串块喂成一条流——chunk 边界故意切在行中间。 */
function streamOf(chunks: string[]): Readable {
  return Readable.from(chunks.map((c) => Buffer.from(c, 'utf8')))
}

describe('消费 pull 流', () => {
  it('跨 chunk 的半个行会拼回来，不重复也不丢', async () => {
    const lines: string[] = []
    await consumeImagePull(
      streamOf([
        '{"status":"Pull',
        'ing fs layer","id":"aaa"}\n{"status":"Downloading","id":"aaa","progress":"50%"}',
        '\n',
      ]),
      (t) => lines.push(t),
    )
    expect(lines).toEqual(['Pulling fs layer aaa', 'Downloading aaa 50%'])
  })

  it('最后一行没有换行符也要吐出来', async () => {
    const lines: string[] = []
    await consumeImagePull(streamOf(['{"status":"Done"}']), (t) => lines.push(t))
    expect(lines).toEqual(['Done'])
  })

  it('流内 error 让整条消费抛错（调用方据此发 SSE error）', async () => {
    const lines: string[] = []
    await expect(
      consumeImagePull(
        streamOf(['{"status":"Pulling"}\n', '{"error":"no such host"}\n']),
        (t) => lines.push(t),
      ),
    ).rejects.toThrow(ImagePullError)
    expect(lines).toEqual(['Pulling'])
  })
})
