import { defineConfig } from 'astro/config'

const repository = process.env.GITHUB_REPOSITORY
const [owner, name] = repository?.split('/') ?? []
const pages = process.env.GITHUB_ACTIONS === 'true' && owner && name
const base = process.env.SITE_BASE || (pages && name !== `${owner}.github.io` ? `/${name}` : '/')
const site = process.env.SITE_URL || (pages ? `https://${owner}.github.io` : undefined)

export default defineConfig({
  site,
  base,
  output: 'static',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  build: { format: 'directory' },
})