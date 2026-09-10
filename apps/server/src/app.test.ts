import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp, type AppDeps } from './app.js'
import { countAdmins, findUserById, setUserRole } from './db/user-repo.js'

/**
 * 改角色的守卫内联在 app.ts 里（要先查目标、再数管理员，然后才写），只有把这三个
 * repo 函数换成假的才测得到；同模块其余函数保持真实实现。
 */
vi.mock('./db/user-repo.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/user-repo.js')>()),
  findUserById: vi.fn(),
  countAdmins: vi.fn(),
  setUserRole: vi.fn(),
}))

type FakeSession = {
  user: { id: string; role: string }
  session: { impersonatedBy: string | null }
}

/** 默认是「冒充出来的管理员会话」——绝大多数边界用例要的就是它被拒。 */
function dependencies(
  session: FakeSession = {
    user: { id: 'owner', role: 'admin' },
    session: { impersonatedBy: 'operator' },
  },
): AppDeps {
  return {
    env: {
      BASE_DOMAIN: 'app.example.com',
      CONSOLE_DOMAIN: 'console.app.example.com',
      PUBLIC_SCHEME: 'https',
      PLATFORM_SECRET: 'test-platform-secret',
      EXTRA_TRUSTED_ORIGINS: '',
      // 注册表客户端在 buildApp 里就要能解析出 host/namespace/name（D23）
      INSTANCE_IMAGE_REPO: 'ghcr.io/example/dsh-instance',
      INSTANCE_IMAGE_REGISTRY_USER: '',
      INSTANCE_IMAGE_REGISTRY_TOKEN: '',
    },
    auth: {
      handler: vi.fn(async () => new Response('{}')),
      api: {
        getSession: vi.fn(async () => session),
      },
    },
    db: {},
    provisioner: {},
    orchestrator: {},
    storage: {},
  } as unknown as AppDeps
}

describe('platform account boundaries', () => {
  it.each([undefined, 'null', 'https://alice.app.example.com', 'https://evil.example']) (
    'rejects write requests from origin %s before authentication',
    async (origin) => {
      const deps = dependencies()
      const app = await buildApp(deps)
      try {
        for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
          const response = await app.inject({
            method,
            url: '/api/instances/owned/stop',
            headers: origin === undefined ? {} : { origin, 'sec-fetch-site': 'same-site' },
          })
          expect(response.statusCode).toBe(403)
        }
        expect(deps.auth.api.getSession).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    },
  )

  it.each(['https://console.app.example.com', 'http://localhost:5173'])(
    'allows configured console origin %s',
    async (origin) => {
      const deps = dependencies()
      deps.env.EXTRA_TRUSTED_ORIGINS = 'http://localhost:5173'
      const app = await buildApp(deps)
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers: { origin },
          payload: {},
        })
        expect(response.statusCode).toBe(200)
        expect(deps.auth.handler).toHaveBeenCalledOnce()
      } finally {
        await app.close()
      }
    },
  )

  it.each(['impersonate-user', 'set-user-password', 'update-user', 'set-role', 'list-users'])(
    'does not expose the native admin endpoint %s',
    async (endpoint) => {
      const deps = dependencies()
      const app = await buildApp(deps)
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/api/auth/admin/${endpoint}`,
          headers: { origin: 'https://console.app.example.com' },
          payload: {},
        })
        expect(response.statusCode).toBe(403)
        expect(deps.auth.handler).not.toHaveBeenCalled()
      } finally {
        await app.close()
      }
    },
  )

  it('rejects an existing impersonation session on platform APIs', async () => {
    const app = await buildApp(dependencies())
    try {
      const response = await app.inject({ method: 'GET', url: '/api/instances' })
      expect(response.statusCode).toBe(401)
    } finally {
      await app.close()
    }
  })
})

describe('platform admin role guard', () => {
  const admin: FakeSession = {
    user: { id: 'admin-1', role: 'admin' },
    session: { impersonatedBy: null },
  }

  beforeEach(() => {
    vi.mocked(findUserById).mockReset()
    vi.mocked(countAdmins).mockReset()
    vi.mocked(setUserRole).mockReset()
    vi.mocked(setUserRole).mockResolvedValue(true)
  })

  it('refuses to demote the last admin and writes nothing', async () => {
    vi.mocked(findUserById).mockResolvedValue({ id: 'only', role: 'admin' })
    vi.mocked(countAdmins).mockResolvedValue(1)
    const app = await buildApp(dependencies(admin))
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/only/role',
        headers: { origin: 'https://console.app.example.com' },
        payload: { role: 'user' },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('最后一名管理员')
      expect(setUserRole).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('demotes an admin while another one remains', async () => {
    vi.mocked(findUserById).mockResolvedValue({ id: 'other', role: 'admin' })
    vi.mocked(countAdmins).mockResolvedValue(2)
    const app = await buildApp(dependencies(admin))
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/other/role',
        headers: { origin: 'https://console.app.example.com' },
        payload: { role: 'user' },
      })
      expect(response.statusCode).toBe(200)
      expect(setUserRole).toHaveBeenCalledWith({}, 'other', 'user')
    } finally {
      await app.close()
    }
  })

  it('promotes an existing account without counting admins', async () => {
    vi.mocked(findUserById).mockResolvedValue({ id: 'u-x', role: 'user' })
    const app = await buildApp(dependencies(admin))
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/u-x/role',
        headers: { origin: 'https://console.app.example.com' },
        payload: { role: 'admin' },
      })
      expect(response.statusCode).toBe(200)
      expect(setUserRole).toHaveBeenCalledWith({}, 'u-x', 'admin')
      expect(countAdmins).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })

  it('reports a missing target as 404 without writing', async () => {
    vi.mocked(findUserById).mockResolvedValue(undefined)
    const app = await buildApp(dependencies(admin))
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/nobody/role',
        headers: { origin: 'https://console.app.example.com' },
        payload: { role: 'admin' },
      })
      expect(response.statusCode).toBe(404)
      expect(setUserRole).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})