/**
 * 跑数据库迁移（平台镜像的 entrypoint 用）。
 *
 * 和 `db:migrate`（drizzle-kit）的区别：drizzle-kit 是 devDependency，不进运行镜像。
 * 这里用 drizzle-orm 自带的程序化迁移器，只依赖运行时已有的 drizzle-orm + postgres。
 *
 * 迁移目录默认 `./drizzle`，可用 `DRIZZLE_MIGRATIONS_DIR` 覆盖。
 *
 * 用法：node dist/scripts/migrate.js
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { createDb } from '../src/db/client.js'
import { loadEnv } from '../src/env.js'

const env = loadEnv()
const migrationsFolder = process.env.DRIZZLE_MIGRATIONS_DIR ?? './drizzle'

const { db, client } = createDb(env.DATABASE_URL)

try {
  await migrate(db, { migrationsFolder })
  console.log(`迁移完成（${migrationsFolder}）`)
} finally {
  // 不关连接池进程退不掉
  await client.end()
}
