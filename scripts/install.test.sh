#!/usr/bin/env bash
#
# install.sh 的冒烟测试：**只验它能被真正执行**。
#
# 为什么需要它：`bash -n` 只查语法，而"游离的顶层命令"在语法上完全合法 —— 曾经一个
# JSDoc 注释块 `/** */` 被写进这个 shell 脚本，`/**` 被 glob 展开成 `/bin /boot /dev …`
# 然后试图执行 `/bin`，退出码 126，而 `--help` 也测不出来（它在参数解析那一步就 exit 0 了）。
# 于是"脚本从没被真正跑过一次"这件事一直没被发现，直到在一台真机器上装机。
#
# 判定：非 root 下执行，必须**恰好**停在「要 root」这一道检查。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ "$(id -u)" = 0 ]; then
  echo "这个测试必须以**非 root** 跑 —— 以 root 跑会让 install.sh 真的往下装。" >&2
  exit 1
fi

out=$(bash scripts/install.sh 2>&1) && code=0 || code=$?
if [ "$code" -ne 1 ]; then
  echo "✗ 期望退出码 1（停在 root 检查），实际 $code。输出：" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
if ! printf '%s\n' "$out" | grep -q '要 root'; then
  echo "✗ 没停在 root 检查 —— 说明脚本里有游离的顶层命令。实际输出：" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

echo "✓ install.sh 能被执行，且停在预期的第一道检查（要 root）"
