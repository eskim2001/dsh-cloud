#!/usr/bin/env bash
#
# 平台镜像的入口。子命令：
#   migrate   跑数据库迁移
#   seed      建第一个管理员（只在「还没有管理员」时生效，可重复跑）
#   serve     起控制面（默认）
#
# compose 里 postgres 有 healthcheck，但那只保证「容器起来了」，不保证「现在能连」——
# 迁移撞上启动竞态会随机失败。这里再兜一层有限重试。
set -euo pipefail

APP_DIR=/app/server

db_reachable() {
  node --input-type=module -e '
import net from "node:net";
const raw = process.env.DATABASE_URL;
if (!raw) process.exit(1);
const url = new URL(raw);
const socket = net.connect({ host: url.hostname, port: Number(url.port || 5432) });
const done = (code) => { socket.destroy(); process.exit(code); };
socket.on("connect", () => done(0));
socket.on("error", () => done(1));
setTimeout(() => done(1), 2000);
' 2>/dev/null
}

wait_for_db() {
  local tries=60
  until db_reachable; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      echo "等 Postgres 超时（60 秒），DATABASE_URL 指向的还是不通。" >&2
      return 1
    fi
    sleep 1
  done
}

case "${1:-serve}" in
  migrate)
    wait_for_db
    exec node "$APP_DIR/dist/scripts/migrate.js"
    ;;
  seed)
    wait_for_db
    exec node "$APP_DIR/dist/scripts/seed.js"
    ;;
  serve)
    wait_for_db
    exec node "$APP_DIR/dist/src/index.js"
    ;;
  *)
    echo "未知子命令：$1（可用：migrate / seed / serve）" >&2
    exit 1
    ;;
esac
