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
    // 必须显式绑 IPv4：默认 host 是 'localhost'，Node 会解析成 ::1，
    // 而容器里的 Traefik 经 host.docker.internal 只能摸到宿主的 IPv4 回环。
    host: '127.0.0.1',
    // *.localhost / *.dsh.test 解析到回环，本地就能验「cookie 是否覆盖实例子域」
    allowedHosts: ['.localhost', '.dsh.test'],
    // 开发期同源：/api 走 Vite 代理到控制面，避免 CORS 与 cookie 跨端口问题
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
})
