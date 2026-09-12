import type { QueryClient } from '@tanstack/react-query'

/**
 * **所有** react-query key 的唯一出处。
 *
 * 为什么必须收拢：key 原先散在各页面里，`instances` 与 `admin/instances` 是两个**互不失效**
 * 的缓存 —— 在管理面改完配额，用户列表还是旧的；在详情页升级完镜像，舰队页也没变。
 * 这类 bug 的症状是"数据看着没更新"，而根因隔了两个文件。
 */
export const keys = {
  session: ['session'] as const,
  /** 存活探针（侧栏那颗指示灯）。 */
  health: ['health'] as const,
  /** 自己已登录的设备（账号页里那一张表）。 */
  sessions: ['sessions'] as const,
  /** 建实例弹窗里的可选版本（只在弹窗打开时拉）。 */
  createImages: ['create-images'] as const,

  instances: ['instances'] as const,
  instance: (id: string) => ['instance', id] as const,
  instanceStats: (id: string) => ['instance-stats', id] as const,
  /** 末尾带 `limit`：换了时间范围就是另一份数据，不能共用缓存。
   *  失效时传 `keys.instanceMetrics(id)` 仍然命中全部范围（react-query 按前缀匹配）。 */
  instanceMetrics: (id: string, limit: number) => ['instance-metrics', id, limit] as const,
  instanceImage: (id: string) => ['instance-image', id] as const,

  adminUsers: ['admin', 'users'] as const,
  adminInstances: ['admin', 'instances'] as const,
  adminInstanceImage: (id: string) => ['admin', 'instance-image', id] as const,
} as const

/**
 * 任何会改变"实例"的动作之后调它。
 *
 * **两个列表一起失效**：用户面与舰队面看的是同一批实例的两个投影，只刷一个就会出现
 * "这边改了那边没变"。传了 `id` 就把它自己的详情/用量也带上。
 */
export function invalidateInstances(qc: QueryClient, id?: string): void {
  void qc.invalidateQueries({ queryKey: keys.instances })
  void qc.invalidateQueries({ queryKey: keys.adminInstances })
  if (id !== undefined) {
    void qc.invalidateQueries({ queryKey: keys.instance(id) })
    void qc.invalidateQueries({ queryKey: keys.instanceStats(id) })
    void qc.invalidateQueries({ queryKey: keys.instanceImage(id) })
    void qc.invalidateQueries({ queryKey: keys.adminInstanceImage(id) })
  }
}
