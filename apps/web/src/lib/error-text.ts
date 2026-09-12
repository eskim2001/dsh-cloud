import { ApiError } from '@/lib/api.js'

/**
 * 把 mutation 的错误转成一行给人看的文本。
 *
 * **优先用服务端给的文案**（如「已用 200 MB，不能缩到 128 MB」「不能降级最后一名管理员」），
 * 它们比笼统的「操作失败」有用得多；拿不到才回落到调用方给的兜底文案。
 */
export function errorTextOf(error: unknown, fallback: string): string | null {
  if (error === null || error === undefined) return null
  return error instanceof ApiError ? error.message : fallback
}
