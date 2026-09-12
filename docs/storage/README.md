# 给容器一块「有硬上限的持久盘」：选型与实测

> **与具体项目无关的技术记录。** 任何「多租户容器 + 用户在容器里能跑任意代码」的平台都适用。
> 每个数字旁边都标了**是本文实测的、还是引用别人的**。储存相关的新发现都往这个目录里写。

## 问题

容器里那份用户数据（下称 `/data`）要**同时**满足两条：

1. **持久** —— 删容器 / 换镜像不丢（"升级不丢数据"通常是头号承诺）；
2. **有硬上限** —— 灌满就是 `ENOSPC`，不是"预算"。没有这条，一个租户就能写满宿主盘、
   把整台机器上所有实例一起拖垮，触发门槛极低（不需要漏洞、不需要技巧）。

**软限不算**：监控用量再告警/停机是"发现后处理"，不是"灌不进去"。

## 为什么单靠 Docker 给不了

| 看起来能用 | 为什么不行 |
|---|---|
| `--storage-opt size=` | 只限**容器可写层**，管不到挂载进去的卷；**Docker Desktop 上被静默忽略**（无告警） |
| `--tmpfs size=` | 内核强制、跨平台，但**内存盘、重启即丢** → 直接违反性质 1，出局 |
| 命名卷 / bind 宿主目录 | 只是宿主文件系统上的一个目录，**没有任何配额** |

所以硬上限只能来自**文件系统**，而给文件系统设配额是**宿主级操作**（要 `CAP_SYS_ADMIN`）。

> **两条推论：**
> 1. **这件事绕不开一个"有特权的执行者"** —— 它不能是租户容器（给租户 `CAP_SYS_ADMIN` 等于给它
>    宿主 root）；只能是平台侧那双手。平台通常已经通过 docker socket 有了 root 等价权限，
>    所以不是新增特权面，但那个执行者必须收窄（固定镜像、脚本白名单、不接受任何来自实例的输入）。
> 2. **行业上大多数平台不做这件事**（靠节点盘容量 + 超了驱逐）。真做硬限的都用 XFS project quota
>    （K8s 社区拿它当"驱逐的替代"）；而且**普遍接受 dev/prod 在这件事上不一致** ——
>    开发机不强制，只生产强制。

## 四条路 + 实测对照

| 路径 | 硬限 | **Linux 宿主** | **macOS / Docker Desktop** |
|---|---|---|---|
| XFS project quota | ✓ | **实测 ✓** | ✗ 内核裁了配额 |
| ext4 project quota | ✓（可被 `CAP_SYS_RESOURCE` 绕） | 未测（不必） | ✗ 内核不认 `-O project` |
| btrfs subvolume + qgroup/squota | ✓ | 未测 | **引用：有 ✓ 的记录** |
| 固定大小镜像 + loop 挂载 | ✓（= 文件系统大小，不用配额特性） | 实测 loop/mount ✓ | **引用：有 ✓ 的记录** |

- **Linux 实测环境**：Debian 12 / 内核 6.1 / Docker 29（KVM guest），2026-09-12。
- **macOS 实测**：Docker Desktop / linuxkit 内核 6.10.14 —— `mkfs.xfs` 与 `mount -t xfs` **都正常**，
  失败的**只有配额那一档**：`mount -o pquota` / `-o usrquota` 一律 `EINVAL`，内核 config 是
  `# CONFIG_XFS_QUOTA is not set` + `# CONFIG_QFMT_V1/V2 is not set`（配额格式模块也没编）。
- **"引用"= 我没亲手复现** —— 用之前自己跑一遍。

## 做法：一个池子 + 每租户一个 project ID

一块盘当池子（XFS，`pquota` 挂载）；宿主不是 XFS 时，放**一块大的 loopback XFS 镜像**当池子
（**整机一个 loop**，不是每租户一个）。

```bash
mount -o pquota /dev/sdb1 /pool                      # 池子（也可是 loopback 镜像）
mkdir -p /pool/<key>
xfs_quota -x -c 'project -s -p /pool/<key> 1001' /pool        # -s 会顺带设继承标志
xfs_quota -x -c 'limit -p bhard=256m ihard=65536 1001' /pool  # 字节 + inode 都要设
xfs_quota -x -c 'report -p -b -h' /pool                       # 用量：读不要权限
```

**为什么是它：**

- 硬限在文件系统的**分配路径上**强制，容器里有多少 capability 都改不了，开销约等于零；
- **没有每租户的 loop / mount** → 没有"宿主重启后挂载全消失、要按序恢复"那套内核态状态要管；
- **扩缩容就是改一个数字**。缩容也能做：**已用超了新限额 = 拒绝再写，数据不丢**。
  （对比：每租户一个 ext4 镜像时 **ext4 缩不了**，只能重建 + 迁移。）
- 租户目录里 `statfs` 报的是**配额**，不是宿主盘 → 顺带满足"租户看不到宿主真实容量"。

**实测数字（Linux，真 XFS）：**

| 项 | 结果 |
|---|---|
| 建池（loopback 镜像 4 GiB + mkfs + mount） | **79 ms** |
| 建租户（目录 + project + 双限额） | ~7 ms |
| 限 256 MiB 灌 400 MiB | **只写进 256.0 MiB**，然后 ENOSPC |
| 租户目录 `statfs` | **total = 256.0 MiB**（池子 4032 MiB） |
| 用量 | `report` 读到 256 |
| 扩到 512 后 | 能继续写 |
| 缩到 128 后 | 写入被拒，**原有数据还在** |
| 快照（复制一份） | 拿到**新** projid，与实例各自的账互不串 |
| 顺序写 128 MiB / 建 2000 个小文件 | 74 MB/s / 64 ms —— 与"每租户一个 loop 镜像"**无差别**（78 MB/s / 58 ms） |

**结论：速度不是选型理由**（差的那 ~28 ms 建租户开销，相对实例启动的秒级时间是噪声）。

### 必须一起做的四件事

1. **字节和 inode 配额都要设。** 只限字节的话，几百万个零字节文件就能把宿主 inode 耗尽，
   整台机器都会瘫。
2. **启动自检：真设一次限额、再读回它的值。** `report`（读）不要权限，只有 `limit`（写）要 ——
   缺权限时 `limit` 是**静默失败**。**只看"是不是 XFS + 开了 pquota"不够；只看那个 ID 出没出现也不够**
   （`project -s` 本身就让 ID 出现）。必须校验 **Hard 列的值**。自检不过就**拒绝启动**。
3. **快照 / 副本要有自己的 project ID。** 共用源的 ID 会让快照算进租户的账，接近限额时快照直接失败。
4. **复制时先给目标设好 project（带继承标志）再 `cp -a`** —— `cp -a` 不会把 inode 的 projid 带过去，
   靠的是继承。

### project ID 怎么分配

**别用哈希派生**：32 位哈希在用了几万个租户后必然碰撞，而碰撞 = **两个租户的账静默合并**。
做法：**选最低空闲 ID 并落盘**（池子根一个点文件就够），**已释放的 ID 不复用**，
启动时与实际目录对账、回收泄漏的 ID。

## 开发机怎么办（macOS / Docker Desktop）

**不做硬限，只打一行警告。** 它的内核把配额整块裁了（见上）。

关键操作原则：**界面上的"配额"必须标成"无上限"**，别让它看着像生效了 ——
静默的配置失败比报错糟得多（有同类项目专门为此加了警告 PR，见下）。

## 踩过的坑（都是实测出来的）

| 坑 | 事实 |
|---|---|
| 解析 `xfs_quota report` | 列序是 `#ID Used Soft Hard Warn/Grace Flags` —— **第二列才是用量**；第一列是 project ID。（踩过：把 ID 当用量，永远读回 0。） |
| 一次调用同时带 `-b -i` | 输出**两段表**（块 / inode），表头之外没有可靠分段标记 → 按行解析会串。**分两次调用**。 |
| `df` 报的是不是配额 | **是** —— 前提是目录带 `PROJINHERIT`（`project -s` 会设；只打 project ID 不设继承标志则不报）。实测：池子 4032 MiB / 租户目录 256.0 MiB。 |
| 池子能缩容吗 | **不能** —— XFS 只增不减。**扩容可以在线做**（`truncate` + `losetup -c` + `xfs_growfs`）；要缩只能重建 + 迁移。 |
| 池化 = 物理隔离吗 | **不是，是逻辑隔离** —— 每租户一个镜像时"盘就那么大，配额逻辑错了也写不出去"；池化**全靠配额设对了**。所以自检是硬前提，不是可选项。 |
| 池子的全局性 | 它满了 / 坏了是**全局**影响（这正是配额存在的理由）；每租户一个则坏一个不牵连别人。 |
| 声明的容量存哪 | loop 镜像那套可放卷 label；池化那套没有卷了 → 放驱动自己的注册表（复制时要照着搬）。 |

## 参考（含"别人怎么做"）

- K8s 的 `ephemeral-storage` 限额默认是**驱逐**（软限，"写多了赶你走"）；要**硬限**，社区做法是
  XFS project quota：
  [Quotas for Ephemeral Storage（KEP-1029）](https://www.kubernetes.dev/resources/keps/1029/)、
  [Kubernetes 1.25: Local Storage Capacity Isolation GA](https://v1-34.docs.kubernetes.io/blog/2022/09/19/local-storage-capacity-isolation-ga/)、
  [用 XFS 项目配额替代驱逐](https://blog.csdn.net/woloqun/article/details/162898705)
- macOS 上做不到（公开的已知问题）：[docker/for-mac #7576 "Docker not respecting disk usage limit"](https://github.com/docker/for-mac/issues/7576)
- 有项目干脆把"macOS 上限额被静默忽略"从沉默改成警告 —— 值得照抄的姿态：
  [hermes-agent PR #82969](https://github.com/NousResearch/hermes-agent/pull/82969)
- 内核侧的机制（`statvfs` 感知项目配额、以及"只在带 `PROJINHERIT` 的目录上生效"）：
  [XFS statvfs component of directory/project quota support](https://git.zx2c4.com/linux-dev/commit/fs/xfs/quota?id=932f2c323196c214e645d5a572a1d7b562c0f93f)、
  [LU-15721 projid quota limit statfs() only with PROJINHERIT](https://jira.whamcloud.com/browse/LU-15721)

## 本平台怎么落的

- 决策：[`docs/DECISIONS.md`](../DECISIONS.md) **D18**（一个 XFS 池 + 每租户一个 project ID；
  宿主非 XFS 时自动建 loopback 池子；开发机不强制 + 一行警告）。
- 实现：`apps/server/src/instance/pool.ts`（池子判定 / loopback 兜底 / 严格自检 / project ID 注册表）、
  `apps/server/src/runtime/docker/driver.ts` 的存储方法。
- 边界情况见 [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) §四 的残余风险。
