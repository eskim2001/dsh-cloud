/** 把 MiB 显示成人读得懂的尺寸：整 GB 不带小数，不到 1 GB 用 MB。 */
export function formatMb(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`
  const gb = mb / 1024
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
}

/**
 * 从入口 URL 取出主机名。
 *
 * 用户要复制/看的是**地址**，不是带入口 token 的完整路径——那条 URL 里的 token 是一次性的，
 * 贴出去既没用又碍眼。
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
