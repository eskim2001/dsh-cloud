import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as retryDelay } from 'node:timers/promises'
import type Docker from 'dockerode'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDocker } from '../docker/client.js'
import { createAuth } from '../auth.js'
import { loadEnv } from '../env.js'
import { createDb } from './client.js'
import { imageRelease, instance, user } from './schema.js'
import {
  countInstancesByOwner, createInstanceRecord, findInstanceById,
  findInstanceBySlug, listAllInstances, listInstancesByOwner,
  QuotaExceededError, retainInstanceRecord, SlugTakenError, type NewInstance,
} from './instance-repo.js'
import {
  findDefaultImageRelease, isImageRelease, listImageReleases,
  publishImageRelease, setDefaultImageRelease, unpublishImageRelease,
} from './image-release-repo.js'
import {
  isImageInCatalog, listImageCatalog, pruneImageCatalog, upsertImageCatalog,
} from './image-catalog-repo.js'
import { syncImageCatalog } from '../instance/image-sync.js'
import {
  countAdmins, findUserByEmail, findUserById, listInstancesWithOwner,
  listUsersWithInstanceCount, setUserRole,
} from './user-repo.js'

describe.runIf(process.env.DSH_SECURITY_INTEGRATION === '1')('instance storage and quota database boundaries', () => {
  let container: Docker.Container | undefined
  let database: ReturnType<typeof createDb> | undefined
  const legacyOwner = randomUUID()
  const legacyId = randomUUID()

  beforeAll(async () => {
    const docker = createDocker()
    const password = randomUUID()
    container = await docker.createContainer({
      Image: 'postgres:16-alpine',
      Env: [`POSTGRES_PASSWORD=${password}`, 'POSTGRES_DB=security_test'],
      ExposedPorts: { '5432/tcp': {} },
      HostConfig: {
        PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
        Tmpfs: { '/var/lib/postgresql/data': 'rw,size=512m' },
      },
    })
    await container.start()
    const info = await container.inspect()
    const port = info.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort
    if (port === undefined) throw new Error('No isolated PostgreSQL port')
    database = createDb(`postgres://postgres:${password}@127.0.0.1:${port}/security_test`)
    for (let attempt = 0; ; attempt++) {
      try {
        await database.client`select 1`
        break
      } catch (error) {
        if (attempt >= 60) throw error
        await retryDelay(100)
      }
    }
    const journal = JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    for (const entry of journal.entries) {
      if (entry.tag === '0005_instance_storage_identity') {
        await database.client`insert into "user" (id,name,email,email_verified,created_at,updated_at)
          values (${legacyOwner},'Legacy','legacy@example.test',false,now(),now())`
        await database.client`insert into instance (id,slug,owner_id,image,cpus,memory_mb)
          values (${legacyId},'legacy-data',${legacyOwner},'dsh-instance:0.1.0',1,2048)`
      }
      const migration = await readFile(new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8')
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await database.client.unsafe(statement)
      }
    }
  }, 60_000)

  afterAll(async () => {
    await database?.client.end()
    await container?.remove({ force: true, v: true })
  })

  async function owner(quota: number | null = null): Promise<string> {
    const id = randomUUID()
    await database!.db.insert(user).values({
      id, name: 'Test', email: `${id}@example.test`, emailVerified: false,
      createdAt: new Date(), updatedAt: new Date(), instanceQuota: quota,
    })
    return id
  }

  function input(ownerId: string, slug = randomUUID().replaceAll('-', '')): NewInstance {
    return { id: randomUUID(), slug, ownerId, image: 'dsh-instance:0.1.0', cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 1024 }
  }

  it('migrates existing instances without changing their data paths', async () => {
    const row = await findInstanceById(database!.db, legacyId)
    expect(row?.storageKey).toBe('legacy-data')
    expect(row?.deletedAt).toBeNull()
  })

  it('denies account takeover through the real authentication plugin', async () => {
    const auth = createAuth(loadEnv({
      DATABASE_URL: 'postgres://unused', BASE_DOMAIN: 'app.example.com',
      CONSOLE_DOMAIN: 'console.app.example.com',
      PLATFORM_SECRET: randomUUID(), BETTER_AUTH_SECRET: randomUUID(),
    }), database!.db)
    const email = `${randomUUID()}@example.test`
    const password = randomUUID()
    const registration = await auth.api.signUpEmail({ body: { name: 'Operator', email, password } })
    await database!.db.update(user).set({ role: 'admin' }).where(eq(user.id, registration.user.id))
    const login = await auth.handler(new Request('https://console.app.example.com/api/auth/sign-in/email', {
      method: 'POST', headers: { origin: 'https://console.app.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }))
    expect(login.status).toBe(200)
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    expect((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.role).toBe('admin')
    const target = await owner()
    for (const endpoint of ['impersonate-user', 'set-user-password', 'update-user']) {
      const response = await auth.handler(new Request(`https://console.app.example.com/api/auth/admin/${endpoint}`, {
        method: 'POST',
        headers: { cookie, origin: 'https://console.app.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ userId: target, newPassword: randomUUID(), data: { email: 'taken@example.test' } }),
      }))
      expect(response.status).toBe(403)
    }
  })

  it('retains a soft-deleted slug for its owner: same account may reuse it, another may not', async () => {
    const firstOwner = await owner()
    const secondOwner = await owner()
    const previous = await createInstanceRecord(database!.db, input(firstOwner, 'reused-name'), 1)
    await retainInstanceRecord(database!.db, previous.id)

    // 换个人不行：域名一旦回收，上一个租户留在这个域名下的浏览器状态就被继承了
    await expect(
      createInstanceRecord(database!.db, input(secondOwner, 'reused-name'), 1),
    ).rejects.toBeInstanceOf(SlugTakenError)

    const next = await createInstanceRecord(database!.db, input(firstOwner, 'reused-name'), 1)
    expect(next.storageKey).not.toBe(previous.storageKey)
    expect(next.storageKey).not.toBe(next.slug)
    expect(next.storageKey).toMatch(/^[a-f0-9]{32}$/)
    const [retained] = await database!.db.select().from(instance).where(eq(instance.id, previous.id))
    expect(retained?.ownerId).toBe(firstOwner)
    expect(retained?.storageKey).toBe(previous.storageKey)
    expect(retained?.deletedAt).toBeInstanceOf(Date)
    expect(await findInstanceById(database!.db, previous.id)).toBeUndefined()
    expect((await findInstanceBySlug(database!.db, 'reused-name'))?.id).toBe(next.id)
    expect(await listInstancesByOwner(database!.db, firstOwner)).toEqual([next])
    expect(await countInstancesByOwner(database!.db, firstOwner)).toBe(1)
    expect((await listAllInstances(database!.db)).some(row => row.id === previous.id)).toBe(false)
    expect((await listInstancesWithOwner(database!.db)).some(row => row.id === previous.id)).toBe(false)
    expect((await listUsersWithInstanceCount(database!.db)).find(row => row.id === firstOwner)?.instanceCount).toBe(1)
  })

  it('allows only the configured quota under concurrent creates', async () => {
    const ownerId = await owner(2)
    const results = await Promise.allSettled(Array.from({ length: 10 }, () =>
      createInstanceRecord(database!.db, input(ownerId), 10),
    ))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2)
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(QuotaExceededError)
    }
    expect(await countInstancesByOwner(database!.db, ownerId)).toBe(2)
  })

  it('respects a zero quota and the default quota', async () => {
    await expect(createInstanceRecord(database!.db, input(await owner(0)), 3)).rejects.toBeInstanceOf(QuotaExceededError)
    const ownerId = await owner()
    await createInstanceRecord(database!.db, input(ownerId), 1)
    await expect(createInstanceRecord(database!.db, input(ownerId), 1)).rejects.toBeInstanceOf(QuotaExceededError)
  })

  it('rejects a duplicate active slug and rolls back the reservation', async () => {
    const ownerId = await owner()
    await createInstanceRecord(database!.db, input(ownerId, 'occupied-name'), 3)
    await expect(createInstanceRecord(database!.db, input(ownerId, 'occupied-name'), 3)).rejects.toBeInstanceOf(SlugTakenError)
    expect(await countInstancesByOwner(database!.db, ownerId)).toBe(1)
  })

  it('finds an account by email regardless of case', async () => {
    const id = randomUUID()
    const email = `${id}@Example.Test`
    await database!.db.insert(user).values({
      id, name: 'Mixed Case', email, emailVerified: false,
      createdAt: new Date(), updatedAt: new Date(),
    })
    // 库里存的是混合大小写。按小写查不命中 → seed 会以「账号不存在」再建一个同邮箱，
    // 改角色会以「用户不存在」404——两种都是静默的错人。
    expect((await findUserByEmail(database!.db, email.toLowerCase()))?.id).toBe(id)
    expect((await findUserByEmail(database!.db, email.toUpperCase()))?.id).toBe(id)
    expect(await findUserByEmail(database!.db, `${randomUUID()}@example.test`)).toBeUndefined()
    expect((await findUserById(database!.db, id))?.role).toBe('user')
  })

  it('counts admins and persists role changes to the real column', async () => {
    const baseline = await countAdmins(database!.db)
    expect(typeof baseline).toBe('number')
    const target = await owner()
    expect(await setUserRole(database!.db, target, 'admin')).toBe(true)
    expect(await countAdmins(database!.db)).toBe(baseline + 1)
    expect((await findUserById(database!.db, target))?.role).toBe('admin')
    expect(await setUserRole(database!.db, target, 'user')).toBe(true)
    expect(await countAdmins(database!.db)).toBe(baseline)
    expect((await findUserById(database!.db, target))?.role).toBe('user')
    expect(await setUserRole(database!.db, randomUUID(), 'admin')).toBe(false)
  })

  it('publishes image releases idempotently and enforces a single default', async () => {
    const db = database!.db
    // 重跑 seed 不炸：同一个 ref 第二次是 'exists'
    expect(await publishImageRelease(db, 'dsh-instance:0.1.0', true)).toBe('ok')
    expect(await publishImageRelease(db, 'dsh-instance:0.1.0', true)).toBe('exists')
    expect((await findDefaultImageRelease(db))?.ref).toBe('dsh-instance:0.1.0')
    expect(await isImageRelease(db, 'dsh-instance:0.1.0')).toBe(true)
    expect(await isImageRelease(db, 'dsh-instance:9.9.9')).toBe(false)
    // 没发布过就设不成默认
    expect(await setDefaultImageRelease(db, 'dsh-instance:9.9.9')).toBe(false)

    // 换默认走事务 + 部分唯一索引：换完仍然**只有一个** true
    expect(await publishImageRelease(db, 'dsh-instance:0.1.1')).toBe('ok')
    expect(await setDefaultImageRelease(db, 'dsh-instance:0.1.1')).toBe(true)
    const rows = await listImageReleases(db)
    expect(rows.filter((r) => r.isDefault).map((r) => r.ref)).toEqual(['dsh-instance:0.1.1'])

    // 默认版本不可下架；非默认可以，下完再下是 'missing'
    expect(await unpublishImageRelease(db, 'dsh-instance:0.1.1')).toBe('default')
    expect(await unpublishImageRelease(db, 'dsh-instance:0.1.0')).toBe('ok')
    expect(await unpublishImageRelease(db, 'dsh-instance:0.1.0')).toBe('missing')
    expect((await findDefaultImageRelease(db))?.ref).toBe('dsh-instance:0.1.1')
  })

  /**
   * 平台没有默认版本 = 用户创建不了实例。所以上架第一版必须顺手把默认定下来 ——
   * 而且「有没有默认」的读要和插入在**同一个事务**里，否则两个管理员同时上架第一版时
   * 两边都读到「没有」，第二个插入会撞 `image_release_default_unique` 部分唯一索引，
   * 而 `onConflictDoNothing` 的仲裁者只有 `ref`，挡不住 —— 直接 23505 → 500。
   */
  it('并发上架第一版：恰好一个默认，且不撞部分唯一索引', async () => {
    const db = database!.db
    await db.delete(imageRelease) // 制造「全新安装」的起点

    const results = await Promise.all([
      publishImageRelease(db, 'dsh-instance:0.9.0_1', true),
      publishImageRelease(db, 'dsh-instance:0.9.0_2', true),
    ])
    expect(results).toEqual(['ok', 'ok'])

    const defaults = (await listImageReleases(db)).filter((r) => r.isDefault)
    expect(defaults).toHaveLength(1)
  })

  it('已有默认版本时不抢默认；一行默认都没有时会补一个', async () => {
    const db = database!.db
    await db.delete(imageRelease)

    expect(await publishImageRelease(db, 'dsh-instance:0.9.1_1', true)).toBe('ok')
    expect((await findDefaultImageRelease(db))?.ref).toBe('dsh-instance:0.9.1_1')

    // 已经有默认了，第二版不抢
    expect(await publishImageRelease(db, 'dsh-instance:0.9.1_2', true)).toBe('ok')
    expect((await findDefaultImageRelease(db))?.ref).toBe('dsh-instance:0.9.1_1')

    // 制造「有版本但一行默认都没有」的死状态：老逻辑只要求发布、不要求设默认，
    // 这种库真实存在，而且症状就是「用户建不了实例」。
    await db.update(imageRelease).set({ isDefault: false })
    expect(await findDefaultImageRelease(db)).toBeUndefined()

    expect(await publishImageRelease(db, 'dsh-instance:0.9.1_3', true)).toBe('ok')
    expect((await findDefaultImageRelease(db))?.ref).toBe('dsh-instance:0.9.1_3')
  })

  it('keeps the image catalog as a disposable snapshot (D23)', async () => {
    const db = database!.db
    await upsertImageCatalog(db, [
      { ref: 'dsh-instance:0.1.2_2', digest: 'sha256:aaa' },
      { ref: 'dsh-instance:0.1.2_1', digest: 'sha256:bbb' },
    ])
    expect((await listImageCatalog(db)).map((r) => r.ref)).toEqual([
      'dsh-instance:0.1.2_1',
      'dsh-instance:0.1.2_2',
    ])
    expect(await isImageInCatalog(db, 'dsh-instance:0.1.2_2')).toBe(true)
    expect(await isImageInCatalog(db, 'dsh-instance:9.9.9_9')).toBe(false)

    // 上游重推同一 tag → digest 刷新，不新增行
    await upsertImageCatalog(db, [{ ref: 'dsh-instance:0.1.2_2', digest: 'sha256:ccc' }])
    const refreshed = await listImageCatalog(db)
    expect(refreshed).toHaveLength(2)
    expect(refreshed.find((r) => r.ref === 'dsh-instance:0.1.2_2')?.digest).toBe('sha256:ccc')

    // 上游删掉的 tag 跟着消失；整表清空也是合法结果（keepRefs 为空）
    expect(await pruneImageCatalog(db, ['dsh-instance:0.1.2_2'])).toBe(1)
    expect(await pruneImageCatalog(db, [])).toBe(1)
    expect(await listImageCatalog(db)).toEqual([])
  })

  it('syncs registry tags into the catalog and reports ignored shapes', async () => {
    const db = database!.db
    const client = {
      listTags: async () => ['0.1.2-rc.1_3', 'latest', '0.1.2-rc.1_2'],
      tagDigest: async (tag: string) => `sha256:${tag}`,
    }

    const result = await syncImageCatalog(db, client, 'dsh-instance')
    expect(result).toMatchObject({ count: 2, skipped: 1 })
    expect((await listImageCatalog(db)).map((r) => r.ref)).toEqual([
      'dsh-instance:0.1.2-rc.1_2',
      'dsh-instance:0.1.2-rc.1_3',
    ])

    // 下一次同步上游只剩一个 tag → 另一个从表里消失
    const second = await syncImageCatalog(
      db,
      { listTags: async () => ['0.1.2-rc.1_3'], tagDigest: async () => 'sha256:new' },
      'dsh-instance',
    )
    expect(second).toMatchObject({ count: 1, skipped: 0 })
    expect((await listImageCatalog(db)).map((r) => r.ref)).toEqual(['dsh-instance:0.1.2-rc.1_3'])
  })
})