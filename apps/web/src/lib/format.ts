/** 把 MiB 显示成人读得懂的尺寸：整 GB 不带小数，不到 1 GB 用 MB。 */
export function formatMb(mb: number): string {
  if (mb < 1024) return `${Math.round(mb)} MB`
  const gb = mb / 1024
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`
}
