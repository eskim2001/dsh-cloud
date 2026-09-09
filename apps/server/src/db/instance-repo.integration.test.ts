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
import { instance, user } from './schema.js'
import {
  countInstancesByOwner, createInstanceRecord, findInstanceById,
  findInstanceBySlug, listAllInstances, listInstancesByOwner,
  QuotaExceededError, retainInstanceRecord, SlugTakenError, type NewInstance,
} from './instance-repo.js'
import { listInstancesWithOwner, listUsersWithInstanceCount } from './user-repo.js'

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
      PLATFORM_SECRET: randomUUID(), BETTER_AUTH_SECRET: randomUUID(),
      INSTANCE_IMAGE: 'dsh-instance:0.1.0',
    }), database!.db)
    const email = `${randomUUID()}@example.test`
    const password = randomUUID()
    const registration = await auth.api.signUpEmail({ body: { name: 'Operator', email, password } })
    await database!.db.update(user).set({ role: 'admin' }).where(eq(user.id, registration.user.id))
    const login = await auth.handler(new Request('https://app.example.com/api/auth/sign-in/email', {
      method: 'POST', headers: { origin: 'https://app.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }))
    expect(login.status).toBe(200)
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    expect((await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.role).toBe('admin')
    const target = await owner()
    for (const endpoint of ['impersonate-user', 'set-user-password', 'update-user']) {
      const response = await auth.handler(new Request(`https://app.example.com/api/auth/admin/${endpoint}`, {
        method: 'POST',
        headers: { cookie, origin: 'https://app.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ userId: target, newPassword: randomUUID(), data: { email: 'taken@example.test' } }),
      }))
      expect(response.status).toBe(403)
    }
  })

  it('retains ownership and gives a reused slug a different filesystem', async () => {
    const firstOwner = await owner()
    const secondOwner = await owner()
    const previous = await createInstanceRecord(database!.db, input(firstOwner, 'reused-name'), 1)
    await retainInstanceRecord(database!.db, previous.id)
    const next = await createInstanceRecord(database!.db, input(secondOwner, 'reused-name'), 1)
    expect(next.storageKey).not.toBe(previous.storageKey)
    expect(next.storageKey).not.toBe(next.slug)
    expect(next.storageKey).toMatch(/^[a-f0-9]{32}$/)
    const [retained] = await database!.db.select().from(instance).where(eq(instance.id, previous.id))
    expect(retained?.ownerId).toBe(firstOwner)
    expect(retained?.storageKey).toBe(previous.storageKey)
    expect(retained?.deletedAt).toBeInstanceOf(Date)
    expect(await findInstanceById(database!.db, previous.id)).toBeUndefined()
    expect((await findInstanceBySlug(database!.db, 'reused-name'))?.id).toBe(next.id)
    expect(await listInstancesByOwner(database!.db, firstOwner)).toEqual([])
    expect(await countInstancesByOwner(database!.db, firstOwner)).toBe(0)
    expect((await listAllInstances(database!.db)).some(row => row.id === previous.id)).toBe(false)
    expect((await listInstancesWithOwner(database!.db)).some(row => row.id === previous.id)).toBe(false)
    expect((await listUsersWithInstanceCount(database!.db)).find(row => row.id === firstOwner)?.instanceCount).toBe(0)
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
})