import { Readable } from 'node:stream'
import type Docker from 'dockerode'
import { describe, expect, it, vi } from 'vitest'
import { InstanceOrchestrator } from './orchestrator.js'

const REPO = 'ghcr.io/eskim2001/dsh-instance'
const REF = `${REPO}:0.1.2-rc.1_2`

function notFound(): Error {
  return Object.assign(new Error('no such image'), { statusCode: 404 })
}

/** 假 Docker：`present` 里的 ref 视为已在宿主上，其余 inspect 抛 404。 */
function fakeDocker(present: string[], pull?: (ref: string) => Readable) {
  const onHost = new Set(present)
  const docker = {
    getImage: (ref: string) => ({
      inspect: async () => {
        if (!onHost.has(ref)) throw notFound()
        return {}
      },
    }),
    pull: vi.fn(async (ref: string) => pull?.(ref) ?? Readable.from([''])),
  }
  return { docker: docker as unknown as Docker, pull: docker.pull }
}

/** 一行 docker pull 的输出（逐行 JSON）。 */
function pullLine(obj: unknown): Readable {
  return Readable.from([`${JSON.stringify(obj)}\n`])
}

describe('ensureImage（D23 兜底拉取）', () => {
  it('镜像已在宿主上 → 直接返回，不拉', async () => {
    const { docker, pull } = fakeDocker([REF])
    await new InstanceOrchestrator(docker, 'dsh-ingress', REPO).ensureImage(REF)
    expect(pull).not.toHaveBeenCalled()
  })

  it('已在宿主上的**非平台**镜像也放行（D22 之前的实例 image 是裸 tag）', async () => {
    const { docker, pull } = fakeDocker(['dsh-instance:0.1.0'])
    await expect(
      new InstanceOrchestrator(docker, 'dsh-ingress', REPO).ensureImage('dsh-instance:0.1.0'),
    ).resolves.toBeUndefined()
    expect(pull).not.toHaveBeenCalled()
  })

  it('缺镜像 + 非平台仓库 → 拒（这条路径会真的出网，ref 来自库里的历史值）', async () => {
    const { docker, pull } = fakeDocker([])
    await expect(
      new InstanceOrchestrator(docker, 'dsh-ingress', REPO).ensureImage('docker.io/library/nginx:latest'),
    ).rejects.toThrow(/拒绝拉取非平台镜像/)
    expect(pull).not.toHaveBeenCalled()
  })

  it('缺镜像 + 平台仓库 → 拉，并消费到流结束', async () => {
    const { docker, pull } = fakeDocker([], () => pullLine({ status: 'Pulled', id: 'abc' }))
    await new InstanceOrchestrator(docker, 'dsh-ingress', REPO).ensureImage(REF)
    expect(pull).toHaveBeenCalledWith(REF)
  })

  it('同一 ref 并发调用只拉一次', async () => {
    const { docker, pull } = fakeDocker([], () => pullLine({ status: 'Pulled', id: 'abc' }))
    const orchestrator = new InstanceOrchestrator(docker, 'dsh-ingress', REPO)
    await Promise.all([orchestrator.ensureImage(REF), orchestrator.ensureImage(REF)])
    expect(pull).toHaveBeenCalledTimes(1)
  })

  it('流内 error（HTTP 200 + {"error":…}）→ 抛「拉取镜像 … 失败」', async () => {
    const { docker } = fakeDocker([], () => pullLine({ error: 'manifest unknown' }))
    await expect(
      new InstanceOrchestrator(docker, 'dsh-ingress', REPO).ensureImage(REF),
    ).rejects.toThrow(/拉取镜像 .* 失败：manifest unknown/)
  })
})

describe('openImagePull（控制台「下载」用）', () => {
  it('镜像已在宿主上 → 空流（调用方照常读到流结束）', async () => {
    const { docker, pull } = fakeDocker([REF])
    const stream = await new InstanceOrchestrator(docker, 'dsh-ingress', REPO).openImagePull(REF)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    expect(chunks).toEqual([])
    expect(pull).not.toHaveBeenCalled()
  })

  it('缺镜像 + 非平台仓库 → 拒（路由层已校验，这里再挡一次）', async () => {
    const { docker } = fakeDocker([])
    await expect(
      new InstanceOrchestrator(docker, 'dsh-ingress', REPO).openImagePull('evil/backdoor:latest'),
    ).rejects.toThrow(/拒绝拉取非平台镜像/)
  })
})
