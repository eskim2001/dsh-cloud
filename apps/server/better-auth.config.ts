// 仅供 `@better-auth/cli generate` 读取 schema 用，不参与运行时。
// 校验方式：生成结果与本包 src/db/schema.ts 的 auth 部分必须一致。
import { createAuth } from './src/auth.js'
import { createDb } from './src/db/client.js'
import type { Env } from './src/env.js'

const env: Env = {
  DATABASE_URL: 'postgres://localhost:5432/placeholder',
  BASE_DOMAIN: 'app.example.com',
  CONSOLE_DOMAIN: 'console.app.example.com',
  PLATFORM_SECRET: 'x'.repeat(32),
  BETTER_AUTH_SECRET: 'y'.repeat(32),
  PORT: 3000,
  PUBLIC_SCHEME: 'https',
  EXTRA_TRUSTED_ORIGINS: '',
  TRAEFIK_ENTRYPOINT: 'websecure',
  TRAEFIK_CERT_RESOLVER: '',
  MAX_INSTANCES_PER_USER: 3,
  HOST_STORAGE_ROOT: '/var/lib/dsh',
  INSTANCE_UPSTREAM_HOST: '127.0.0.1',
  INSTANCE_IMAGE_REPO: 'ghcr.io/eskim2001/dsh-instance',
  INSTANCE_IMAGE_REGISTRY_USER: '',
  INSTANCE_IMAGE_REGISTRY_TOKEN: '',
}

const { db } = createDb(env.DATABASE_URL)
export const auth = createAuth(env, db)
