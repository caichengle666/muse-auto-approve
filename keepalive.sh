#!/bin/bash
# muse-autoapprove 保活脚本：daemon 进程死了（或假死）就拉起来
# 由 cron 每 15 分钟调用一次；平时无输出，拉起/重启才记一行日志（log/keepalive.log）。
#
# cron 示例（cron 的 PATH 很精简，务必写绝对路径）：
#   */15 * * * * /bin/bash /abs/path/to/muse-auto-approve/keepalive.sh >/dev/null 2>&1
# node 装在 nvm 里也能找到（见下方 NODE_BIN）；也可以在 cron 行里显式写 NODE_BIN=/abs/path/to/node。
#
# 行为：
#   - 存在 data/muse-daemon.stop（用户要求停止）或 data/login.blocked（自动登录熔断）时什么都不做
#   - flock 防并发：同一时刻只有一个 keepalive 在检查/拉起
#   - 只认"本目录"的 daemon：命令行里的 muse-daemon.cjs 解析成绝对路径后必须就是 $ROOT/muse-daemon.cjs
#     （别处的克隆、less/vim 打开这个文件、--once/--check 巡检都不算）
#   - 进程活着但心跳文件 data/muse-daemon.heartbeat 超过 MUSE_KEEPALIVE_STALE_SEC（默认 1800 秒）没更新 -> 视为假死，杀掉重拉
#   - 可选 $ROOT/.env（KEY=VALUE，建议 chmod 600）：cron 环境没有 MUSE_USER/MUSE_PASSWORD/MUSE_PROXY 时从这里读
#
# 环境变量（都可选）：NODE_BIN、MUSE_PROXY、MUSE_KEEPALIVE_STALE_SEC、MUSE_KEEPALIVE_WAIT_SEC（拉起后观察秒数，默认 20）
set -u
# 脚本所在目录即项目根目录（不依赖固定路径，搬到哪都能用）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DATA="$ROOT/data"
PIDFILE="$DATA/muse-daemon.pid"
STOPFILE="$DATA/muse-daemon.stop"
BLOCKFILE="$DATA/login.blocked"
HEARTBEAT="$DATA/muse-daemon.heartbeat"
LOCKFILE="$DATA/keepalive.lock"
DAEMON_JS="$ROOT/muse-daemon.cjs"
LOG="$ROOT/log/keepalive.log"
STALE_SEC="${MUSE_KEEPALIVE_STALE_SEC:-1800}"
WAIT_SEC="${MUSE_KEEPALIVE_WAIT_SEC:-20}"

mkdir -p "$ROOT/log" "$DATA"
log() { echo "$(date -u +%FT%TZ) keepalive $*" >>"$LOG"; }

# keepalive.log 自身也限长：超过 1MB 只留最后 2000 行
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -n 2000 "$LOG" >"$LOG.tmp.$$" 2>/dev/null && mv -f "$LOG.tmp.$$" "$LOG"
fi

# 用户要求停止 / 登录熔断：不拉起
[ -f "$STOPFILE" ] && exit 0
if [ -f "$BLOCKFILE" ]; then
  # 每次都记会刷屏：只在熔断文件比上次记录新时记一行
  if [ ! -f "$DATA/.keepalive-blocked-noted" ] || [ "$BLOCKFILE" -nt "$DATA/.keepalive-blocked-noted" ]; then
    log "data/login.blocked 存在（自动登录熔断），不拉起；排查后运行 node work/login-lib.cjs 解除"
    : >"$DATA/.keepalive-blocked-noted"
  fi
  exit 0
fi

# 并发锁：优先 flock；没有 flock（如 macOS）时退回 mkdir 锁
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE"
  flock -n 9 || exit 0
else
  LOCKDIR="$LOCKFILE.d"
  if ! mkdir "$LOCKDIR" 2>/dev/null; then
    # 持有者已不在（陈旧锁，超过 10 分钟）则回收，否则跳过本次
    if [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      rm -rf "$LOCKDIR"; mkdir "$LOCKDIR" 2>/dev/null || exit 0
    else
      exit 0
    fi
  fi
  trap 'rm -rf "$LOCKDIR"' EXIT
fi

# 可选的 .env（cron 下没有交互式 shell 的环境变量）
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

# 若所在网络需要代理才能访问 muse.ai，在这里设置或导出 MUSE_PROXY
# 例：export MUSE_PROXY="http://127.0.0.1:7890"
# （不设置则直连；也可以直接用 https_proxy 等环境变量，本脚本会自动沿用）
export MUSE_PROXY="${MUSE_PROXY:-${https_proxy:-${HTTPS_PROXY:-${http_proxy:-${HTTP_PROXY:-}}}}}"

# node 绝对路径：NODE_BIN > PATH 里的 node > nvm 安装的最高版本 > 常见安装位置
if [ -z "${NODE_BIN:-}" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(ls -1d "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1)"
  fi
  if [ -z "$NODE_BIN" ]; then
    for c in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node; do [ -x "$c" ] && { NODE_BIN="$c"; break; }; done
  fi
fi

# 判断 pid 是否是"本目录的常驻 daemon"（不是巡检/体检、也不是别处的克隆或打开该文件的编辑器）
is_our_daemon() {
  local pid="$1" a script="" cwd args_line
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    local -a args
    mapfile -d '' args <"/proc/$pid/cmdline" 2>/dev/null || return 1
    [ "${#args[@]}" -ge 2 ] || return 1
    case "$(basename -- "${args[0]}")" in node|node[0-9]*|nodejs) ;; *) return 1 ;; esac
    for a in "${args[@]:1}"; do
      case "$a" in --once|--check|--smoke|--dry) return 1 ;; esac
      case "$a" in */muse-daemon.cjs|muse-daemon.cjs) [ -z "$script" ] && script="$a" ;; esac
    done
    [ -n "$script" ] || return 1
    if [ "${script#/}" = "$script" ]; then
      cwd="$(readlink -f -- "/proc/$pid/cwd" 2>/dev/null)" || return 1
      script="$cwd/$script"
    fi
    [ "$(readlink -f -- "$script" 2>/dev/null)" = "$(readlink -f -- "$DAEMON_JS")" ]
  else
    # 无 /proc（macOS 等）：退回检查完整命令行里含本目录的绝对路径
    args_line="$(ps -p "$pid" -o args= 2>/dev/null)" || return 1
    case "$args_line" in *"--once"*|*"--check"*|*"--smoke"*|*"--dry"*) return 1 ;; esac
    case "$args_line" in *"$DAEMON_JS"*) return 0 ;; *) return 1 ;; esac
  fi
}

find_daemon() {
  local pid
  if [ -f "$PIDFILE" ]; then
    pid="$(tr -d '[:space:]' <"$PIDFILE" 2>/dev/null)"
    if is_our_daemon "$pid"; then echo "$pid"; return 0; fi
  fi
  # pid 文件不可靠时再按进程名兜底（方括号写法避免 pgrep 匹配到自己），逐个核实是不是本目录的
  for pid in $(pgrep -f "muse-daemon[.]cjs" 2>/dev/null); do
    if is_our_daemon "$pid"; then echo "$pid"; return 0; fi
  done
  return 1
}

heartbeat_age() {
  local now mt
  [ -f "$HEARTBEAT" ] || { echo -1; return; }
  now="$(date +%s)"
  mt="$(stat -c %Y "$HEARTBEAT" 2>/dev/null || stat -f %m "$HEARTBEAT" 2>/dev/null || echo "$now")"
  echo $((now - mt))
}

proc_age() { ps -o etimes= -p "$1" 2>/dev/null | tr -d ' '; }

if PID="$(find_daemon)"; then
  age="$(heartbeat_age)"
  page="$(proc_age "$PID")"
  # 进程已跑超过 STALE_SEC，但心跳缺失或超过 STALE_SEC 未更新 -> 假死
  if [ -n "$page" ] && [ "$page" -gt "$STALE_SEC" ] 2>/dev/null && { [ "$age" -lt 0 ] || [ "$age" -gt "$STALE_SEC" ]; }; then
    log "pid=$PID heartbeat stale (${age}s) -> restart"
    kill "$PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do is_our_daemon "$PID" || break; sleep 1; done
    is_our_daemon "$PID" && kill -9 "$PID" 2>/dev/null
  else
    exit 0
  fi
fi

# 死了：拉起来
if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  log "node not found (NODE_BIN=${NODE_BIN:-<empty>}); set NODE_BIN=/abs/path/to/node in the cron line"
  exit 1
fi
cd "$ROOT" || exit 1
# stdout 丢弃（与 log/daemon-log.ndjson 完全重复）；stderr 保留到 log/daemon-stderr.log（daemon 每小时裁剪）
nohup "$NODE_BIN" "$DAEMON_JS" --loop 10000 --always --fallback-once \
  >/dev/null 2>>"$ROOT/log/daemon-stderr.log" </dev/null 9>&- &
NEWPID=$!
log "restarted daemon pid=$NEWPID node=$NODE_BIN proxy=${MUSE_PROXY:+set}"
# 给它 WAIT_SEC 秒启动，确认还活着（pid 文件由 daemon 自己写）
sleep "$WAIT_SEC"
if kill -0 "$NEWPID" 2>/dev/null; then
  log "pid=$NEWPID healthy"
  exit 0
else
  log "pid=$NEWPID DIED quickly, check log/daemon-stderr.log and log/daemon-log.ndjson"
  exit 1
fi
