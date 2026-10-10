#!/bin/bash
# muse-autoapprove 保活脚本：daemon 进程死了就拉起来
# 由定时任务每 15 分钟调用一次；平时无输出，拉起成功才记一行日志。
set -u
# 脚本所在目录即项目根目录（不依赖固定路径，搬到哪都能用）
ROOT="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$ROOT/data/muse-daemon.pid"
LOG="$ROOT/log/keepalive.log"

# 若所在网络需要代理才能访问 muse.ai，在这里设置或导出 MUSE_PROXY
# 例：export MUSE_PROXY="http://127.0.0.1:7890"
# （不设置则直连；也可以直接用 https_proxy 等环境变量，本脚本会自动沿用）
export MUSE_PROXY="${MUSE_PROXY:-${https_proxy:-${HTTPS_PROXY:-${http_proxy:-${HTTP_PROXY:-}}}}}"

alive=0
if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    if ps -p "$PID" -o args= 2>/dev/null | grep -q "muse-daemon"; then
      alive=1
    fi
  fi
fi
# pid 文件不可靠时再用进程名兜底（方括号写法避免 pgrep 匹配到自己）
if [ "$alive" -eq 0 ] && pgrep -f "muse-daemon[.]cjs" >/dev/null 2>&1; then
  alive=1
fi
[ "$alive" -eq 1 ] && exit 0

# 死了：拉起来
cd "$ROOT" || exit 1
mkdir -p "$ROOT/log" "$ROOT/data"
nohup node muse-daemon.cjs --loop 10000 --always --fallback-once \
  >>"$ROOT/log/daemon-stdout.log" 2>&1 &
NEWPID=$!
echo "$NEWPID" > "$PIDFILE"
echo "$(date -u +%FT%TZ) keepalive restarted daemon pid=$NEWPID proxy=${MUSE_PROXY:+set}" >>"$LOG"
# 给它 20 秒启动，确认还活着
sleep 20
if kill -0 "$NEWPID" 2>/dev/null; then
  echo "$(date -u +%FT%TZ) keepalive pid=$NEWPID healthy" >>"$LOG"
  exit 0
else
  echo "$(date -u +%FT%TZ) keepalive pid=$NEWPID DIED quickly, check log/daemon-log.ndjson" >>"$LOG"
  exit 1
fi
