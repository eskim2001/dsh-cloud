import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { stringify as toYaml } from 'yaml'

/**
 * 往 file provider 的目录里**原子**写一份动态配置。
 *
 * 两件事都不能省：
 * - **原子**（tmp + rename）：Traefik 在 watch 这个目录，读到写了一半的文件会拒收整份，
 *   那一瞬间**所有**路由消失。
 * - **YAML**：directory 模式下只读 `.yml` / `.yaml` / `.toml`，`.json` 会被**静默忽略**
 *   （表现为所有路由 404 且不报错）。
 */
export async function writeDynamicConfig(configPath: string, config: unknown): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true })
  const tmp = `${configPath}.tmp`
  await writeFile(tmp, toYaml(config), 'utf8')
  await rename(tmp, configPath)
}

/**
 * 删掉一份动态配置，返回**原本是否存在**。
 *
 * 用不带 `force` 的 `rm` 并吞掉 ENOENT，是为了把「删掉了」和「本来就没有」分开 —— 调用方
 * （启动时的投影）靠它说清这一轮到底改变了什么，而不是每轮都报同一串文件名。
 *
 * 这条也是「配完域名就把引导页的暴露关掉」的实现手段：删掉文件，Traefik 立刻摘掉那条路由，
 * 不需要重启、也不需要改什么绑定地址。
 */
export async function removeDynamicConfig(configPath: string): Promise<boolean> {
  try {
    await rm(configPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}
