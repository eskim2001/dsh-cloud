/**
 * 一次性迁移：把存量实例的 named volume 数据搬进 D18 的 loop 文件系统。
 *
 * 迁移窗口内实例要停：先把容器停掉再复制，避免复制到一半文件还在变。
 * **旧卷不删**——搬完留着，万一新文件系统有问题可以退回去。
 * 跑完这个脚本就该删掉，它不是长期资产。
 *
 * 用法：pnpm --filter @dsh-cloud/server migrate:img
 */
import { createDb } from '../src/db/client.js'
import { createDocker, demuxFrames } from '../src/docker/client.js'
import { HostStorage } from '../src/instance/host-storage.js'

const ROOT = process.env.HOST_STORAGE_ROOT ?? '/var/lib/dsh'
const HELPER = process.env.STORAGE_HELPER_IMAGE ?? 'alpine:3.20'
const UID = 1000
const GID = 1000

const docker = createDocker()
const storage = new HostStorage(docker, { root: ROOT, helperImage: HELPER })
const { client } = createDb(process.env.DATABASE_URL ?? '')

/** 在宿主上跑一段命令，返回 stdout。 */
async function host(script: string): Promise<string> {
  const container = await docker.createContainer({
    Image: HELPER,
    Cmd: ['nsenter', '-t', '1', '-m', '-u', '-n', '-i', 'sh', '-c', script],
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: { Privileged: true, PidMode: 'host', NetworkMode: 'none' },
  })
  const stream = await container.attach({ stream: true, stdout: true, stderr: true })
  const chunks: Buffer[] = []
  const drained = new Promise<void>((resolve, reject) => {
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  await container.start()
  const { StatusCode } = await container.wait()
  await drained
  await container.remove({ force: true })
  const out = demuxFrames(Buffer.concat(chunks)).trim()
  if (StatusCode !== 0) throw new Error(`宿主命令失败（exit ${String(StatusCode)}）：${out}`)
  return out
}

const rows = await client<Array<{ slug: string; disk_mb: number }>>`
  select slug, disk_mb from instance
  where deleted_at is null and storage_key = slug
  order by slug
`

for (const { slug, disk_mb: diskMb } of rows) {
  const src = `/var/lib/docker/volumes/dsh-data-${slug}/_data`
  const mount = storage.mountPoint(slug)

  if ((await host(`test -d ${src} && echo yes || echo no`)) !== 'yes') {
    console.log(`${slug}: 没有旧卷，跳过`)
    continue
  }

  // 停容器再复制：迁移期间不允许有写入
  const container = docker.getContainer(`dsh-instance-${slug}`)
  await container.stop({ t: 10 }).catch(() => undefined)

  await storage.create(slug, diskMb)
  const srcCount = Number(await host(`find ${src} | wc -l`))
  const dstCount = Number(await host(`find ${mount} | wc -l`))
  if (dstCount > 2) {
    console.log(`${slug}: 目标已有数据（${String(dstCount)} 个条目），跳过复制`)
  } else {
    await host(`cp -a ${src}/. ${mount}/ && chown -R ${String(UID)}:${String(GID)} ${mount}`)
    const after = Number(await host(`find ${mount} | wc -l`))
    if (after < srcCount) {
      throw new Error(`${slug}: 复制不完整（源 ${String(srcCount)} → 目标 ${String(after)}）`)
    }
    console.log(`${slug}: ${String(srcCount)} → ${String(after)} 个条目`)
  }

  // 删掉旧容器：它 bind 的还是旧卷，必须让平台按新规格重建
  await container.remove({ force: true }).catch(() => undefined)
  console.log(`${slug}: 旧容器已移除，等平台启动时重建`)
}

await client.end()
console.log('\n迁移完成。旧卷仍保留在 dsh-data-* 下，确认无误后可自行删除。')
