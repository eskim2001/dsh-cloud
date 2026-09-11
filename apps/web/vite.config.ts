import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // shadcn 组件用 `@/...` 导入，Vite 不读 tsconfig 的 paths，得自己配一份
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: {
    port: 5173,
    // 端口写死在入口配置里（host.docker.internal:5173），被占时宁可报错，
    // 别自动换到 5174——换了 Traefik 就 502。
    strictPort: true,
    // 必须显式绑 IPv4：默认 host 是 'localhost'，Node 会解析成 ::1，
    // 而容器里的 Traefik 经 host.docker.internal 只能摸到宿主的 IPv4 回环。
    host: '127.0.0.1',
    // *.localhost / *.lvh.me 解析到回环，本地就能验「cookie 是否覆盖实例子域」
    allowedHosts: ['.localhost', '.lvh.me'],
    /**
     * HMR 走 Traefik。开发入口是 `https://console.lvh.me`（`pnpm dev` 打印的那个），
     * Traefik 终结 TLS 再明文反代给 Vite，所以 WebSocket 必须是 **wss :443** ——
     * Traefik 的 HTTP router 默认放行 upgrade。
     *
     * 不配的话：Vite 客户端把 HMR 主机当成 `server.host`（127.0.0.1），又按页面的 https
     * 用 wss，于是去连 `wss://127.0.0.1:5173` —— 那是明文 HTTP，必然失败，
     * 热更新整个不工作（页面照常能开，所以很容易被当成噪音忽略）。
     *
     * 代价：直连 `http://127.0.0.1:5173` 时 HMR 也会去连 console.lvh.me。那个入口本来
     * 就不受支持（cookie 要跨子域、实例路由只在 Traefik 上），所以不算损失。
     */
    hmr: { protocol: 'wss', host: 'console.lvh.me', clientPort: 443 },
    // 开发期同源：/api 走 Vite 代理到控制面，避免 CORS 与 cookie 跨端口问题
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
