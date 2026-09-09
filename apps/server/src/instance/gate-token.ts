import { createHmac } from 'node:crypto'

/**
 * 桥的 header 门 token（D8 ③）。
 *
 * 由平台密钥和实例 slug 确定性派生：不需要存库，容器 env 与 forward-auth
 * 各自算一遍即可对上。**平台密钥轮换后必须重建实例容器**，否则桥会 403。
 */
export function gateToken(slug: string, secret: string): string {
  return createHmac('sha256', secret).update(`dsh-cloud:gate:${slug}`).digest('base64url')
}
