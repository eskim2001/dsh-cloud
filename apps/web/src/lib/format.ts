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

/**
 * 从镜像引用里取出 tag（`ghcr.io/acme/img:1.2.3` → `1.2.3`）。
 *
 * 升级下拉框里真正有差异的只有 tag：候选**只可能来自平台自己的仓库**（服务端发布时强制校验），
 * 而那个前缀已经显示在「当前版本」那一栏。整串塞进选择框的话，每个选项前五十个字符都一样，
 * 真正的差异反而被挤没了。
 *
 * 没有 tag 时原样返回 —— `ImageRefSchema` 允许不带 tag，也允许带端口的 registry
 * （`reg:5000/img`），冒号在最后一个 `/` 之前就属于那两种，不能当成 tag 分隔符。
 */
export function imageTagOf(ref: string): string {
  const at = ref.lastIndexOf(':')
  if (at === -1 || at < ref.lastIndexOf('/')) return ref
  return ref.slice(at + 1)
}
