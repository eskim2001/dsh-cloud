import { sql } from 'drizzle-orm'
import { boolean, index, integer, pgTable, real, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// ─── better-auth 管理的表 ────────────────────────────────────────────────
// 字段名与 better-auth 1.7 的默认 drizzle schema 一致；改这里等于改认证。
// `role` / `banned` / `banReason` / `banExpires` 来自 admin 插件，
// `impersonatedBy` 同理——不装插件时这些列不会被写。

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  /** 'user' | 'admin'。管理员是**平台运营方**，不是实例的 owner（见 admin-routes）。 */
  role: text('role').notNull().default('user'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  /**
   * 这个用户最多能开几个实例。NULL = 用平台默认值（MAX_INSTANCES_PER_USER）。
   * 平台自己的字段，better-auth 不认——但同表存着最省事。
   */
  instanceQuota: integer('instance_quota'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** 管理员代入（impersonate）时记下是谁代入的。 */
    impersonatedBy: text('impersonated_by'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

// ─── 平台自己的表 ────────────────────────────────────────────────────────

/**
 * 一个实例 = 一个容器 + 一个卷 + 一个网络 + 一条 Traefik 路由。
 *
 * `slug` 是**唯一**的对外标识，也是容器/卷/网络名的来源——它已过
 * `InstanceSlugSchema` 白名单，所以拼名字是安全的（见 orchestrator 注释）。
 */
export const instance = pgTable(
  'instance',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    storageKey: text('storage_key').notNull().unique().default(sql`replace(gen_random_uuid()::text, '-', '')`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** 谁能打开它。授权判定的唯一依据（D8 ②）。 */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** provisioning | running | stopped | error | removing */
    status: text('status').notNull().default('provisioning'),
    image: text('image').notNull(),
    /**
     * 上一版镜像。**非空 = 有一份升级前的数据快照可回滚**（快照本身在宿主上，
     * `<HOST_STORAGE_ROOT>/<slug>.img.prev`，不进库）。回滚成功后置回 NULL。
     */
    previousImage: text('previous_image'),
    containerId: text('container_id'),
    cpus: real('cpus').notNull(),
    memoryMb: integer('memory_mb').notNull(),
    pidsLimit: integer('pids_limit').notNull().default(512),
    /**
     * 磁盘配额 = 数据文件系统的大小（D18）。不是 Docker 参数，
     * 由 `host-storage` 落地成宿主上一个 ext4 文件系统。
     */
    diskMb: integer('disk_mb').notNull().default(10_240),
    /** 最近一次编排失败的原因，供管理台显示。 */
    lastError: text('last_error'),
    /**
     * 最后一次变成 stopped 的时刻。由 `updateInstance` 按 status 自动维护，
     * 调用方不用管——详情页用它显示「已停止多久」。
     */
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('instance_owner_id_idx').on(t.ownerId),
    uniqueIndex('instance_slug_unique').on(t.slug).where(sql`${t.deletedAt} IS NULL`),
  ],
)

/**
 * 用量采样。一分钟一条，按实例维度存——**跨实例聚合是错的**（铁律 7），
 * 查询永远带 `instanceId`。
 *
 * 保留 30 天，由采样任务顺带清理。
 */
export const instanceMetric = pgTable(
  'instance_metric',
  {
    id: text('id').primaryKey(),
    /** 实例记录删了就跟着删——指标属于记录，不属于数据文件系统。 */
    instanceId: text('instance_id')
      .notNull()
      .references(() => instance.id, { onDelete: 'cascade' }),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull().defaultNow(),
    /** CPU 占用百分比（100 = 用满一个核，可以超过 100）。 */
    cpuPercent: real('cpu_percent').notNull(),
    memMb: integer('mem_mb').notNull(),
    /**
     * 已用磁盘 MB。读的是**文件系统超级块**（`df` 口径），不是 `du` 估算——
     * 后者会跳会偏，还会漏掉已删除但仍被打开的文件。
     */
    diskUsedMb: integer('disk_used_mb').notNull().default(0),
  },
  (t) => [index('instance_metric_instance_sampled_idx').on(t.instanceId, t.sampledAt)],
)

export type InstanceRow = typeof instance.$inferSelect
export type InstanceStatus = InstanceRow['status']
export type InstanceMetricRow = typeof instanceMetric.$inferSelect
