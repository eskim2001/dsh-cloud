# 开发计划

> 目标：把 `dsh` 做成可运营的多租户 SaaS 平台。
> 架构见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)；决策见 [DECISIONS.md](docs/DECISIONS.md)；待验证见 [OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)。

## 总纲

**先做一条垂直闭环，别水平铺开。** 平台核心价值 = 「建实例 → 给一个带配额 / 卷 / 路由的隔离 dsh → **只有平台认证过的人能打开** → 升级 dsh 不丢内容」。这条通了，平台就成立。

## MVP 边界

| 不做 | 什么时候做 |
|---|---|
| 可观测性（Prometheus / Loki / Grafana） | M2 |
| 备份 / 镜像扫描 / 对象存储 | M2 |
| 计费 / 支付 / 充值 / 钱包 | M3 |
| K8s / microVM / 多机 | M4 |
| 外壳 / iframe 包裹（dsh 占满整页即可） | 按需，晚于 MVP |
| dsh 内部机制（密钥存储、模型端点） | 交给 dsh |

## 技术选型

**基础设施**：Docker · Traefik · Postgres
**后端**：Fastify · Drizzle · better-auth · dockerode
**前端**：Vite + React · shadcn/ui + Tailwind · TanStack Query
**实例容器**：dsh（pin 版本）· Caddy · tini · 自研两段式 Dockerfile
**MVP 不上**：Redis / 队列 · Prometheus 全家桶 · 备份 · 镜像扫描

## 组件清单（build vs buy）

**直接用开源**：Docker · Traefik · Postgres · better-auth · dockerode · Fastify · Drizzle · shadcn/Tailwind · TanStack Query · tini · Caddy

**必须自研（平台价值所在，就这 6 样）**

| # | 自研件 | 说明 |
|---|---|---|
| ① | **实例规格 + renderer** | `instance-spec` → Docker 资源；换 K8s / microVM 只换这层 |
| ② | **升级 / 回滚 + 回归验证** | 换镜像 tag + 黄金路径测试集 |
| ③ | **配额执行 + 用量统计** | 采集 → 落库 → 判定 |
| ④ | **三道门编排** | 独立网络 + forward-auth + header 门 |
| ⑤ | **管理台** | 实例列表 / 详情 / 打开 / 升级 / 配额 |
| ⑥ | **插件目录规范 + 校验** | 只收标准 client 包 |

## 里程碑

### M1 能跑 —— ✅ 已完成

- [x] 脚手架：pnpm workspace + `apps/server` + `apps/web` + `packages/instance-spec`
- [x] 实例镜像：两段式 Dockerfile + tini + `DSH_HOME=/data` + **WORKDIR 落 `/data`**
- [x] 编排闭环：dockerode 起一个带配额 + 数据文件系统 + 独立网络的容器
- [x] 三道门：forward-auth + 每实例 gate token + 路由生成
- [x] 页面：登录 + 实例列表 / 详情 / 打开
- [x] 磁盘配额（D18）、升级 / 回滚（D19）、配额管理（D17）、状态现算（D16）

### M2 能管

实例列表 / 详情 / 建 / 升级 / 回滚 UI 完善；插件目录规范；workspace 独立卷；对账循环；审计日志；可观测性与备份。

### M3 能卖

注册 / 充值 / 钱包 / 计费 / 套餐 / 配额判定；**实测单容器资源占用**（定配额档位与底价）。

### M4 演进

K8s renderer；microVM / gVisor renderer；token 计费；更多形态（headless / acp / sdk）。

## 验收表（缺一条不算过）

每次改隔离边界、认证链路或升级流程，都要重跑这张表。

| # | 动作 | 期望 |
|---|---|---|
| 1 | 未登录访问 `<slug>.app.example.com` | 弹回登录页，**打不开** |
| 2 | 登录他人账号访问该实例 | 拒绝 |
| 3 | 登录 owner 账号 | 正常打开 dsh，能对话 |
| 4 | 无签名直连容器 `:8080` | **403** |
| 5 | 从实例 A 容器内扫实例 B / 连 Postgres | **不通** |
| 6 | 换新镜像 tag 重启 | workspace / 会话 / 插件 / 配置**全在** |
| 7 | 容器内 `/data` 写入大文件 | 落进数据文件系统，重建容器后还在 |
| 8 | 打开设置 → 模型提供方，填 key 保存 | 提供方目录正常加载、key 存得进（**D15**；每次升 dsh 必跑） |
| 9 | 在宿主 `docker stop` 实例容器 / 让它 crash-loop | 10 秒内列表与详情显示「已停止」/「重启中」，不是「运行中」（**D16**） |

自动化部分见 `apps/server/src/**/*.test.ts` 与 `pnpm --filter @dsh-cloud/server check:storage`。

## 守则

见 [AGENTS.md](AGENTS.md) §二（铁律）。重点：用户内容必须落 `/data`、插件只收标准包、升级 = 换镜像、验证四级收尾、不钻 dsh 内部、访问控制三道门。
