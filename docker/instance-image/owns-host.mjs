// 平台注入（D15）：声明「页面自己拥有 Host」，把 dsh 客户端的 isLoopback 判真。
// 经平台域名访问时 hostname 永远不是回环，不注入则设置面被降级成 memory，
// 用户连模型提供方 / key 都配不了（OPEN-QUESTIONS #1）。
// 走 dsh 公开扩展点（webServer 的 webserver/index-inject 行 + 官方 --patch），不改官方文件。
export const name = 'platform-owns-host'

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
    })
  })
}
