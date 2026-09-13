import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AcceptInvitationResult } from '../invitation.js'

const AcceptBodySchema = z.object({
  token: z.string().min(16).max(200),
  // 与 better-auth 的默认下限对齐，见 db/account.ts 的 seed 校验
  password: z.string().min(8).max(200),
  name: z.string().trim().max(80).optional(),
})

export interface InvitationRouteDeps {
  acceptInvite(input: {
    token: string
    password: string
    name?: string | undefined
  }): Promise<AcceptInvitationResult>
}

/**
 * 邀请兑换。**这是全平台唯一一个不认证的写端点**（铁律 6 要求显式回答「谁来认证」）。
 *
 * **谁来认证：没有人——这正是它的用途。** 凭据是链接里的一次性 token，靠四件事收窄：
 *   - 库里只存 SHA-256 哈希（`db/invitation-repo.ts`）：拖库也拿不到可用链接；
 *   - 一次性：`markInvitationAccepted` 的条件带 `acceptedAt IS NULL`；
 *   - 有期限：7 天（`INVITE_TTL_HOURS`）；
 *   - 绑邮箱：链接捡到了也得知道是发给谁的，且该邮箱不能已有账号。
 *
 * 它能做的**只有一件事**：建一个 `role='user'` 的账号并设密码。不能建管理员、
 * 不能列任何数据、不能碰已有账号——所以它不比「公开注册」给得更多，而公开注册
 * 已经被关掉了（`auth.ts` 的 `disableSignUp`）。
 *
 * 注意它**不在这里建会话**：前端拿到 email 之后走正常的 `sign-in/email`。
 * 认证路径只保留一条，别在这里开第二条。
 */
export async function registerInvitationRoutes(
  app: FastifyInstance,
  deps: InvitationRouteDeps,
): Promise<void> {
  await app.register(async (scope) => {
    scope.post('/api/invitations/accept', async (req, reply) => {
      const parsed = AcceptBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

      const result = await deps.acceptInvite(parsed.data)
      if (!result.ok) {
        if (result.reason === 'invalid') {
          return reply.code(404).send({ error: '这个邀请链接无效、已过期，或者已经用过了' })
        }
        return reply.code(409).send({ error: '这个邮箱已经有账号了' })
      }
      return { email: result.email }
    })
  })
}
