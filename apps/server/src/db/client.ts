import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>['db']

/**
 * Postgres 连接 + Drizzle。控制面**唯一**的持久化入口。
 *
 * 注意：实例容器**永远**拿不到这个连接（宿主回环发布 + 零跨实例凭据）。
 */
export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} })
  const db = drizzle(client, { schema })
  return { db, client }
}
