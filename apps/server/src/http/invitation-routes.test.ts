import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { AcceptInvitationResult } from '../invitation.js'
import { registerInvitationRoutes } from './invitation-routes.js'

/** 一条长度合法的 token（路由只校验长度，具体有效性是领域层的事）。 */
const TOKEN = 'a'.repeat(32)
const VALID = { token: TOKEN, password: 'password123' }

async function build(acceptInvite: () => Promise<AcceptInvitationResult>) {
  const app = Fastify()
  await registerInvitationRoutes(app, { acceptInvite })
  return app
}

const accept = (app: ReturnType<typeof Fastify>, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/invitations/accept', payload })

describe('邀请兑换：成功路径', () => {
  it('返回 email，且**不建会话**', async () => {
    const app = await build(async () => ({ ok: true, email: 'invitee@example.com' }))
    const res = await accept(app, VALID)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ email: 'invitee@example.com' })
    // 建会话是 better-auth 的事，这条路由只负责把账号建出来。
    // 响应里出现 set-cookie 就说明这里开了第二条认证路径。
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})

describe('邀请兑换：失败路径', () => {
  it('无效 / 过期 / 已用过 → 404，且**不区分**这三种', async () => {
    const app = await build(async () => ({ ok: false, reason: 'invalid' }))
    const res = await accept(app, VALID)

    expect(res.statusCode).toBe(404)
    // 三种原因给同一句话：区分它们等于告诉探测者「这个 token 存在过」
    expect(res.json().error).toBe('这个邀请链接无效、已过期，或者已经用过了')
  })

  it('邮箱已被占 → 409', async () => {
    const app = await build(async () => ({ ok: false, reason: 'exists' }))
    const res = await accept(app, VALID)

    expect(res.statusCode).toBe(409)
  })
})

describe('邀请兑换：参数校验在进建号逻辑之前', () => {
  it('密码太短 → 400，且不调用建号', async () => {
    let called = false
    const app = await build(async () => {
      called = true
      return { ok: true, email: 'x@example.com' }
    })

    const res = await accept(app, { token: TOKEN, password: 'short' })
    expect(res.statusCode).toBe(400)
    expect(called).toBe(false)
  })

  it('token 太短 → 400', async () => {
    const app = await build(async () => ({ ok: true, email: 'x@example.com' }))
    const res = await accept(app, { token: 'x', password: 'password123' })
    expect(res.statusCode).toBe(400)
  })

  it('body 形状不对 → 400', async () => {
    const app = await build(async () => ({ ok: true, email: 'x@example.com' }))
    const res = await accept(app, {})
    expect(res.statusCode).toBe(400)
  })
})
