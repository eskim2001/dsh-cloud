/**
 * 存储层自检（D18）：在真 Docker 上把「loop 文件 + ext4」这条路走一遍。
 *
 * 特权助手容器（nsenter 进宿主）在单测里跑不了，而它正是「数据在不在」的唯一边界，
 * 所以留一个能在开发机上随时重跑的自检：建 → 写 → 重挂 → 扩容 → 缩容 → 快照往返 → 销毁。
 *
 * 只碰自己造的 slug `storcheck`，不涉及任何真实实例。
 *
 * 用法：pnpm --filter @dsh-cloud/server check:storage
 */
import type Docker from 'dockerode'
import { createDocker, demuxFrames } from '../src/docker/client.js'
import { HostStorage } from '../src/instance/host-storage.js'

const SLUG = 'storcheck'
const HELPER = process.env.STORAGE_HELPER_IMAGE ?? 'alpine:3.20'
const ROOT = process.env.HOST_STORAGE_ROOT ?? '/var/lib/dsh'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/** 直接在宿主上跑一段命令（自检要看文件真实大小，只能走这条路）。 */
async function host(docker: Docker, script: string): Promise<string> {
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
  await container.wait()
  await drained
  await container.remove({ force: true })
  return demuxFrames(Buffer.concat(chunks)).trim()
}

/** 以容器里 dsh 的身份（uid 1000）往 /data 写东西——这才是真实的写入路径。 */
async function inData(docker: Docker, mount: string, script: string): Promise<number> {
  const container = await docker.createContainer({
    Image: HELPER,
    Cmd: ['sh', '-c', script],
    User: '1000:1000',
    HostConfig: { Binds: [`${mount}:/data`], NetworkMode: 'none' },
  })
  await container.start()
  const { StatusCode } = await container.wait()
  await container.remove({ force: true })
  return StatusCode
}

async function main(): Promise<void> {
  const docker = createDocker()
  const storage = new HostStorage(docker, { root: ROOT, helperImage: HELPER })
  const mount = storage.mountPoint(SLUG)
  const img = storage.imagePath(SLUG)

  console.log(`root=${ROOT}  挂载点=${mount}\n`)
  await storage.destroy(SLUG)

  await storage.create(SLUG, 512)
  await storage.assertMounted(SLUG)
  check('create 后已挂载', await storage.isMounted(SLUG))

  const before = await storage.usage(SLUG, 512)
  check('新建的空文件系统用量很小', before !== undefined && before.usedMb < 50, JSON.stringify(before))

  const wrote = await inData(
    docker,
    mount,
    'dd if=/dev/zero of=/data/blob bs=1M count=2 2>/dev/null && echo hello > /data/marker.txt',
  )
  check('容器能以 uid 1000 写 /data', wrote === 0, `exit ${String(wrote)}`)

  const used = await storage.usage(SLUG, 512)
  check('用量跟着涨', used !== undefined && used.usedMb >= 2, JSON.stringify(used))

  // 重挂一遍：ensure 只能挂载、不能重建文件系统，否则这里就读不到标记了
  await storage.ensure(SLUG, 512)
  const survived = await inData(
    docker,
    mount,
    'test -s /data/blob && grep -q hello /data/marker.txt',
  )
  check('ensure 之后数据还在（没有静默重建）', survived === 0, `exit ${String(survived)}`)

  await storage.resize(SLUG, 1024)
  const sizeBytes = await host(docker, `stat -c %s ${img}`)
  check('扩容后文件大小 = 1 GiB', sizeBytes === String(1024 * 1024 * 1024), sizeBytes)
  const cap = await host(docker, `df -Pk ${mount} | awk 'NR==2{print $2}'`)
  check(
    '扩容后文件系统容量跟着变大',
    Number(cap) > 900 * 1024,
    `${String(Math.round(Number(cap) / 1024))} MiB`,
  )
  const afterGrow = await inData(
    docker,
    mount,
    'test -s /data/blob && grep -q hello /data/marker.txt',
  )
  check('扩容之后数据还在', afterGrow === 0, `exit ${String(afterGrow)}`)

  await storage.shrink(SLUG, 256)
  check('缩容后已卸载', !(await storage.isMounted(SLUG)))
  await storage.ensure(SLUG, 256)
  const afterShrink = await inData(
    docker,
    mount,
    'test -s /data/blob && grep -q hello /data/marker.txt',
  )
  check('缩容之后数据还在', afterShrink === 0, `exit ${String(afterShrink)}`)

  // 缩到比已用还小：resize2fs 必须**拒绝**，而且不能把文件系统弄坏
  await inData(docker, mount, 'dd if=/dev/zero of=/data/big bs=1M count=100 2>/dev/null')
  let refused = false
  try {
    await storage.shrink(SLUG, 64)
  } catch {
    refused = true
  }
  check('缩到比已用还小 → 拒绝', refused)
  await storage.ensure(SLUG, 256)
  const intact = await inData(
    docker,
    mount,
    'test -s /data/big && test -s /data/blob && grep -q hello /data/marker.txt',
  )
  check('被拒绝的缩容没有损坏数据', intact === 0, `exit ${String(intact)}`)

  // 快照往返（D19）：升级前的退路，快照里必须是「打快照那一刻」的内容。
  // 先写一段**非零**数据——零块会被 --sparse=always 还原成洞，量不出真实占用。
  await inData(docker, mount, 'dd if=/dev/urandom of=/data/rand bs=1M count=8 2>/dev/null')
  await storage.snapshot(SLUG)
  check('打快照后已卸载', !(await storage.isMounted(SLUG)))
  const snapMb = await storage.snapshotUsage(SLUG)
  check(
    '快照实占 ≈ 已用（稀疏复制，不是配额大小）',
    snapMb !== undefined && snapMb >= 8 && snapMb < 200,
    `${String(snapMb)} MB / 配额 256 MB`,
  )

  // 模拟「升级后数据被新版本改了」
  await storage.ensure(SLUG, 256)
  const mutated = await inData(
    docker,
    mount,
    'rm -f /data/blob /data/rand && echo changed > /data/marker.txt',
  )
  check('模拟升级后的改动', mutated === 0, `exit ${String(mutated)}`)

  await storage.restoreSnapshot(SLUG)
  check('回滚后已卸载', !(await storage.isMounted(SLUG)))
  await storage.ensure(SLUG, 256)
  const rolledBack = await inData(
    docker,
    mount,
    'test -s /data/blob && test -s /data/rand && grep -q hello /data/marker.txt',
  )
  check('回滚后内容回到快照那一刻', rolledBack === 0, `exit ${String(rolledBack)}`)
  check('回滚消费掉快照（不能回滚第二次）', (await storage.snapshotUsage(SLUG)) === undefined)
  check(
    '回滚后数据文件仍在（mv 不是复制）',
    (await host(docker, `test -f ${img} && echo ok`)) === 'ok',
  )

  await storage.destroy(SLUG)
  check('销毁后已卸载', !(await storage.isMounted(SLUG)))
  check('销毁后数据文件已删除', (await host(docker, `test -f ${img} || echo gone`)) === 'gone')

  console.log(`\n${failed === 0 ? '全部通过' : `${String(failed)} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
