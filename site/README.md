# dsh-cloud Website

独立 Astro 静态官网，不读取、导入或链接仓库现有文档目录。品牌资源已复制到本站 public 中，构建只需要本目录。

## 本地开发

需要 Node.js 22.12 或更新版本、npm 9.6.5 或更新版本。

```sh
cd site
npm ci
npm run dev
```

中文首页为 `/`，英文首页为 `/en/`。两种语言由一个动态路由模板和一个共享页面组件生成，文案集中在 `src/i18n.ts`。

```sh
npm run build
npm test
npm run preview
```

浏览器验收（先启动开发服务，需要本机 Chrome）：

```sh
npm run test:browser
```

测试覆盖中英页面、桌面与两种手机宽度、图片、复制命令、FAQ、菜单与减少动态效果，截图写入被 Git 忽略的 `test-results/`。可用 `TEST_URL` 指定测试服务地址。

## GitHub Pages

仓库根目录的 `.github/workflows/site.yml` 负责构建与部署。先在 GitHub 仓库 Settings → Pages → Build and deployment 中选择 GitHub Actions，然后推送 main 或手动运行工作流。Pull request 只构建和检查，不部署。

默认从 `GITHUB_REPOSITORY` 计算 Pages 地址与项目子路径。项目仓库部署为 `/<仓库名>/` 和 `/<仓库名>/en/`；用户或组织的 `*.github.io` 仓库使用根路径。

可选构建变量：

| 变量 | 用途 |
| --- | --- |
| `SITE_URL` | 网站 origin，例如自定义域名；用于 canonical 与语言替代链接 |
| `SITE_BASE` | 路径前缀，例如 `/dsh-cloud`；自定义域名使用 `/` |
| `PUBLIC_REPOSITORY_URL` | GitHub 仓库 URL；默认 `https://github.com/eskim2001/dsh-cloud`，可覆盖 |

自定义域名还需要自行配置 DNS 与 Pages 域名设置。工作流不修改 DNS，也不会部署主项目服务端。

模拟项目子路径构建：

```sh
SITE_URL=https://example.github.io SITE_BASE=/dsh-cloud npm run build
SITE_BASE=/dsh-cloud npm test
```

字体通过 npm 本地打包，不依赖外部字体服务；页面没有统计脚本。FAQ、语言切换和导航不依赖客户端框架。复制按钮有成功与失败反馈；动画遵循系统减少动态效果设置。