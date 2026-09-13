import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as retryDelay } from 'node:timers/promises'
import type Docker from 'dockerode'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createUserWithPassword } from '../account.js'
import { createAuth, type Auth } from '../auth.js'
import { createDocker } from '../docker/client.js'
import { loadEnv } from '../env.js'
import { acceptInvitation, hashInviteToken, inviteExpiry, newInviteToken } from '../invitation.js'
import { createDb } from './client.js'
import { invitation, user } from './schema.js'
import {
  createInvitation,
  deleteInvitation,
  findPendingInvitationByEmail,
  listInvitations,
} from './invitation-repo.js'

describe.runIf(process.env.DSH_SECURITY_INTEGRATION === '1')('邀请：数据库与建号边界', () => {
  let container: Docker.Container | undefined
  let database: ReturnType<typeof createDb> | undefined
  let auth: Auth

  beforeAll(async () => {
    const docker = createDocker()
    const password = randomUUID()
    container = await docker.createContainer({
      Image: 'postgres:16-alpine',
      Env: [`POSTGRES_PASSWORD=${password}`, 'POSTGRES_DB=invite_test'],
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
    database = createDb(`postgres://postgres:${password}@127.0.0.1:${port}/invite_test`)
    for (let attempt = 0; ; attempt++) {
      try {
        await database.client`select 1`
        break
      } catch (error) {
        if (attempt >= 60) throw error
        await retryDelay(100)
      }
    }

    const journal = JSON.parse(
      await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: Array<{ tag: string }> }
    for (const entry of journal.entries) {
      const migration = await readFile(
        new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url),
        'utf8',
      )
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await database.client.unsafe(statement)
      }
    }

    auth = createAuth(
      loadEnv({
        DATABASE_URL: 'postgres://unused',
        BASE_DOMAIN: 'app.example.com',
        CONSOLE_DOMAIN: 'console.app.example.com',
        PLATFORM_SECRET: randomUUID(),
        BETTER_AUTH_SECRET: randomUUID(),
      }),
      database.db,
    )
  }, 60_000)

  afterAll(async () => {
    await database?.client.end()
    await container?.remove({ force: true, v: true })
  })

  /** 造一个发出邀请的 owner，返回他的 id。 */
  const newOwner = () =>
    createUserWithPassword(auth, {
      email: `${randomUUID()}@example.test`,
      password: randomUUID(),
      role: 'admin',
    })

  /** 造一条待接受的邀请，返回**明文** token（库里存的是哈希）。 */
  async function pendingInvite(email: string, createdBy: string): Promise<string> {
    const token = newInviteToken()
    await createInvitation(database!.db, {
      tokenHash: hashInviteToken(token),
      email,
      createdBy,
      expiresAt: inviteExpiry(),
    })
    return token
  }

  const invitesFor = (email: string) =>
    database!.db.select().from(invitation).where(eq(invitation.email, email))

  const signIn = (email: string, password: string) =>
    auth.handler(
      new Request('https://console.app.example.com/api/auth/sign-in/email', {
        method: 'POST',
        headers: { origin: 'https://console.app.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      }),
    )

  it('兑换成功后账号能登录，邀请同时被标记为已用', async () => {
    const owner = await newOwner()
    const email = `${randomUUID()}@example.test`
    const password = 'invitee-password-1'
    const token = await pendingInvite(email, owner.id)

    expect(await acceptInvitation(database!.db, auth, { token, password })).toEqual({
      ok: true,
      email,
    })

    // 这一步才证明密码哈希链路是通的——建出账号不等于能登录
    expect((await signIn(email, password)).status).toBe(200)

    const rows = await invitesFor(email)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.acceptedAt).not.toBeNull()
  })

  it('同一条链接用第二次被拒', async () => {
    const owner = await newOwner()
    const email = `${randomUUID()}@example.test`
    const token = await pendingInvite(email, owner.id)

    expect((await acceptInvitation(database!.db, auth, { token, password: 'first-pass-1' })).ok).toBe(true)
    expect(await acceptInvitation(database!.db, auth, { token, password: 'second-pass-1' })).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it('过期的链接兑换不了', async () => {
    const owner = await newOwner()
    const email = `${randomUUID()}@example.test`
    const token = newInviteToken()
    await createInvitation(database!.db, {
      tokenHash: hashInviteToken(token),
      email,
      createdBy: owner.id,
      expiresAt: new Date(Date.now() - 1_000),
    })

    expect(await acceptInvitation(database!.db, auth, { token, password: 'expired-pass-1' })).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it('邮箱已有账号时兑换被拒', async () => {
    const owner = await newOwner()
    const email = `${randomUUID()}@example.test`
    await createUserWithPassword(auth, { email, password: randomUUID() })
    const token = await pendingInvite(email, owner.id)

    expect(await acceptInvitation(database!.db, auth, { token, password: 'taken-pass-1' })).toEqual({
      ok: false,
      reason: 'exists',
    })
  })

  it('明文 token 不落库——库里只有哈希', async () => {
    const owner = await newOwner()
    const email = `${randomUUID()}@example.test`
    const token = await pendingInvite(email, owner.id)

    const rows = await invitesFor(email)
    expect(rows[0]?.tokenHash).toBe(hashInviteToken(token))
    expect(rows[0]?.tokenHash).not.toBe(token)

    // 整个列表序列化一遍：明文不该以任何形式出现在任何列里
    expect(JSON.stringify(await listInvitations(database!.db))).not.toContain(token)
  })

  it('撤销：待接受的删得掉，已接受的删不掉', async () => {
    const owner = await newOwner()

    const pendingEmail = `${randomUUID()}@example.test`
    await pendingInvite(pendingEmail, owner.id)
    const pending = await findPendingInvitationByEmail(database!.db, pendingEmail)
    expect(pending).toBeDefined()
    expect(await deleteInvitation(database!.db, pending!.id)).toBe(true)
    // 删过了再删就是 false
    expect(await deleteInvitation(database!.db, pending!.id)).toBe(false)

    const doneEmail = `${randomUUID()}@example.test`
    const doneToken = await pendingInvite(doneEmail, owner.id)
    await acceptInvitation(database!.db, auth, { token: doneToken, password: 'accepted-pass-1' })
    // 已接受的查不到「待接受」，也不该被删掉——那是条历史记录
    expect(await findPendingInvitationByEmail(database!.db, doneEmail)).toBeUndefined()
    const doneRows = await invitesFor(doneEmail)
    expect(await deleteInvitation(database!.db, doneRows[0]!.id)).toBe(false)
  })

  it('同一条链接被并发兑换：只建出一个账号，只成功一次', async () => {
    const owner = await newOwner()
    const email = `${randomUUID()}@example.test`
    const token = await pendingInvite(email, owner.id)

    const results = await Promise.all([
      acceptInvitation(database!.db, auth, { token, password: 'race-pass-aaa' }),
      acceptInvitation(database!.db, auth, { token, password: 'race-pass-bbb' }),
    ])

    expect(results.filter((r) => r.ok)).toHaveLength(1)
    // 输的那个必须是干净的 exists（撞邮箱唯一约束），不能是未处理的数据库错误
    expect(results.every((r) => r.ok || r.reason === 'exists' || r.reason === 'invalid')).toBe(true)
    expect(await database!.db.select().from(user).where(eq(user.email, email))).toHaveLength(1)
  })
})
