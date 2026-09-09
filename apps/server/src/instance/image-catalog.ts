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

/** 取 tag 部分（`repo:tag` → `tag`）；没有 tag 或只有 digest 时返回 undefined。 */
export function imageTag(ref: string): string | undefined {
  const body = ref.includes('@') ? ref.slice(0, ref.indexOf('@')) : ref
  const colon = body.lastIndexOf(':')
  return colon > body.lastIndexOf('/') ? body.slice(colon + 1) : undefined
}

/**
 * 平台自己的发布 tag 形状：`<dsh版本>_<修订号>`（如 `0.1.2-rc.1_2`）。
 *
 * 仓库是**公开**的，任何 collaborator 都能往里推 `:latest` 之类的 tag，而 `ImageRefSchema`
 * 只挡非法字符、不挡形状。发布与同步都用这个判定把不属于发布序列的 tag 挡在外面。
 */
const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9.-]*_[1-9][0-9]*$/

export function isReleaseTag(ref: string): boolean {
  const tag = imageTag(ref)
  return tag !== undefined && RELEASE_TAG.test(tag)
}

/**
 * 按发布顺序比较两个镜像引用（升序）：先比 `<dsh版本>`，再比 `<修订号>`。
 * 只用来给控制台排个好看的顺序——不是 semver 实现，但把两件容易踩的事处理了：
 * `_10` 要排在 `_9` 后面（数字比，不是字典序），`0.1.2-rc.1` 要排在 `0.1.2` 前面
 * （预发布低于正式版）。
 */
export function compareImageRefs(a: string, b: string): number {
  const [versionA, revisionA] = splitReleaseTag(a)
  const [versionB, revisionB] = splitReleaseTag(b)
  return compareVersions(versionA, versionB) || revisionA - revisionB
}

/** `dsh-instance:0.1.2-rc.1_2` → `['0.1.2-rc.1', 2]`。形状不对时版本为空串、修订号为 0。 */
function splitReleaseTag(ref: string): [string, number] {
  const tag = imageTag(ref) ?? ''
  const underscore = tag.lastIndexOf('_')
  if (underscore < 0) return [tag, 0]
  const revision = Number(tag.slice(underscore + 1))
  return [tag.slice(0, underscore), Number.isFinite(revision) ? revision : 0]
}

function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitPrerelease(a)
  const [coreB, preB] = splitPrerelease(b)
  const core = compareNumericCore(coreA, coreB)
  if (core !== 0) return core
  if (preA === preB) return 0
  if (preA === undefined) return 1
  if (preB === undefined) return -1
  return preA < preB ? -1 : 1
}

function splitPrerelease(version: string): [string, string | undefined] {
  const dash = version.indexOf('-')
  return dash < 0 ? [version, undefined] : [version.slice(0, dash), version.slice(dash + 1)]
}

/** `0.1.10` > `0.1.9`：逐段按数字比，缺段当 0（`0.1` < `0.1.1`）。 */
function compareNumericCore(a: string, b: string): number {
  const sa = a.split('.')
  const sb = b.split('.')
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const diff = Number(sa[i] ?? '0') - Number(sb[i] ?? '0')
    if (Number.isNaN(diff)) return a < b ? -1 : a > b ? 1 : 0
    if (diff !== 0) return diff
  }
  return 0
}
