/**
 * 镜像引用的解析。只做一件事：从 `repo:tag` / `repo@sha256:...` 里取出仓库名，
 * 用来判断「这个 tag 是不是我们自己的实例镜像」。
 *
 * 注册表主机名可以带端口（`registry:5000/dsh-instance:0.1.0`），所以不能简单
 * 按最后一个冒号切——**只有在最后一个 `/` 之后的冒号才是 tag 分隔符**。
 */
export function imageRepo(ref: string): string {
  const body = ref.includes('@') ? ref.slice(0, ref.indexOf('@')) : ref
  const colon = body.lastIndexOf(':')
  return colon > body.lastIndexOf('/') ? body.slice(0, colon) : body
}

/**
 * 只留平台自己仓库里的 tag。宿主上通常还跑着别的镜像（Traefik、Postgres、别人的服务），
 * 它们换不上去（准入会按仓库拒），所以**根本不该出现在选择列表里**。
 */
export function platformTags(tags: string[], platformRef: string): string[] {
  const repo = imageRepo(platformRef)
  return tags.filter((tag) => imageRepo(tag) === repo)
}
