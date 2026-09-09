# dsh-cloud — 开发者 / agent 指南

> 这个文件是给未来的开发 agent（和人）看的地图：这是什么、不能踩的线、在哪写代码、怎么跑。
> 架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，决策见 [docs/DECISIONS.md](docs/DECISIONS.md)，待验证见 [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)。
> （`CLAUDE.md` 是指向本文件的符号链接。）

## 一、我们在做什么

把 `dsh`（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，DeepSeek 开源的 agent harness）做成一个**可运营的多租户 SaaS 平台**：

- 用户注册 → 平台给他一个**隔离的 dsh 容器**（CPU / 内存 / 磁盘配额）；
- 一实例一容器（独立网络），升级 dsh 版本**不丢**用户的插件 / 配置 / UI 改动；
- **访问 dsh 必须经过平台认证**（不能被别人直接访问）。

核心闭环：**建实例 → 起带配额 / 卷 / 路由的隔离 dsh → 只有平台认证过的人能打开 → 升级不丢内容**。

**安全前提**：实例容器 = **不可信代码执行环境**（agent 会 spawn 进程、跑 shell、写文件）。跨实例隔离靠网络 / 文件 / 凭据三条硬边界；剩下的唯一缺口是内核（→ microVM 是后路）。见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §四。

## 二、不能踩的线（铁律）

1. **一切用户内容必须落 `/data`（`$DSH_HOME`）卷**，**包括 workspace**（`WORKDIR` 必须在 `/data` 下，否则容器重建就丢用户工作区）。
2. **插件只收标准 client 包**（`export inject` / `apply` + `dsh.client` manifest）；**禁手写 `window.__ModuleLoader__.load`**（会静默不渲染）。
3. **升级 = 换镜像**，用户内容靠卷保留；要锁依赖版本就真装进 profile-own `node_modules`，别靠 symlink。
4. **验证插件用四级收尾**：`dump-config` 有行 → `/plugins/<id>/client.js` 可拉 → 控制台无 bundle 报错 → **真渲染**。判重启**别用** `/proc/1/uptime`。
5. **不钻 dsh 内部**：密钥存储、模型端点等是 dsh 自己的功能，平台不管细；唯一平台级判断是「别把共享 key 塞进多租户容器」。
6. **访问控制三道门**：① 实例容器挂**独立的** bridge 网络、**不发布任何宿主端口**（入口容器被接进该网络、按容器名接入——发布到宿主回环的端口在 Docker Desktop 上对所有容器可见，见 D3 / OPEN-QUESTIONS #4），实例之间网络层互不可达；② 平台入口对**页面 / API / WS** 都前置认证，且做**授权**（登录者 == owner）；③ 桥校验一个**只有入口会注入的签名 header**（HMAC，每实例独立密钥）。**漏挂认证不会报错，只有洞**：认证是**逐条 router 显式挂的**（不是默认拒绝），漏挂的 router 在 Traefik 里是合法配置——照常 200、无告警、无日志。实例路由有门③ 兜底（token 只在认证 + 授权通过后注入，漏挂表现为 **403 而非裸奔**），但**症状和正常工作一模一样 → 错误不可见**；指向**非实例后端**的新路由没有这层兜底，漏挂就是真洞。→ 实例路由只走 `buildTraefikConfig`；新增非实例路由必须显式决定「谁来认证」；必须有自动化攻击测试。
7. **绝不跨实例**：独立网络 / 独立卷 / 零跨实例凭据。备份、迁移、升级脚本、控制面查询，凡涉及实例数据的地方**必须带实例维度**。

## 三、目录结构

```
dsh-cloud/
├── apps/
│   ├── server/          Fastify + Drizzle + dockerode（控制面）
│   │   ├── src/instance/  唯一接触 runtime 的地方（规格 / 编排 / 存储 / 路由）
│   │   ├── src/http/      路由、forward-auth、日志流
│   │   ├── src/db/        schema + repository
│   │   └── scripts/       存储自检、端到端 spike
│   └── web/             Vite + React 19 + shadcn/ui（管理台）
├── packages/
│   └── instance-spec/   ★ 实例规格 + runtime renderer（换 K8s / microVM 只换这层）
├── docker/
│   ├── instance-image/  实例容器基础镜像（Dockerfile + entrypoint + Caddyfile）
│   ├── traefik/         入口静态 / 开发态配置
│   └── compose/         本地入口栈
└── docs/                架构 / 决策 / 待验证
```

## 四、怎么跑

```bash
pnpm install
```

```bash
pnpm -r typecheck
```

```bash
pnpm -r test
```

实例镜像：

```bash
docker build -f docker/instance-image/Dockerfile -t dsh-instance:0.1.0 docker/instance-image/
```

存储自检（宿主持久化 / 配额 / 扩容缩容，会动 Docker）：

```bash
pnpm --filter @dsh-cloud/server check:storage
```

端到端 spike（起容器 → header 门 → 重建后内容还在）：

```bash
pnpm --filter @dsh-cloud/server spike
```

完整本地链路（TLS + 子域 + cookie 作用域）见 [docker/compose/README.md](docker/compose/README.md)。配置项见 [.env.example](.env.example)。

## 五、约定

- **叫「实例」不叫「租户」**：代码、DB、资源名一律用 instance / slug；`tenant` 一词留给「用户 / 企业」。
- **TS 全 ESM**：相对导入带 `.js` 后缀（`import { x } from './foo.js'`）。
- **测试与源码同目录**（`*.test.ts`），vitest；改行为就补测试。
- **UI 改动优先用 shadcn CLI**（`init` / `add` / `apply`），别手改 CSS 变量；CLI 覆盖不到的地方才手补。
- **改隔离边界 / 数据模型 / 认证链路前先解释**：给「现状 → 根因 → 改后形态 → 代价」，等点头再写码。
- **注释写「为什么」**，不写「做了什么」；命名能表达的不要注释。

## 六、文档索引

| 想了解 | 看 |
|---|---|
| 架构 + 安全模型 + 隔离边界 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 为什么这么定（ADR） | [docs/DECISIONS.md](docs/DECISIONS.md) |
| 待验证 / 待定 | [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) |
| 本地入口栈怎么起 | [docker/compose/README.md](docker/compose/README.md) |
| 项目概览 / 快速开始 | [README.md](README.md) · [README.zh-CN.md](README.zh-CN.md) |
