# muse-auto-approve

> 解放双手，让程序自动帮你永久审批域名通过。

muse.ai 外联审批（HITL 审批卡片）的全自动批准器：纯 Node.js 逆向复刻 muse.ai 客户端协议，无需浏览器——自动登录 → 会话长期有效 → 每 10 秒轮询待审批单 → 自动批准。

## 适用场景

- muse.ai 里 Agent 每次访问新网站都要手动点审批，想彻底解放双手
- 默认策略：`allow_always + destination_domain`——新域名首次自动永久放行，落库为 durable 规则，以后不再弹窗
- 个别单被服务端**明确拒绝**（HTTP 4xx/5xx、`{ok:false}`、rpc error）时回退为 `allow_once`；超时/断线这类结果未知的失败不回退，下一轮仍 pending 时按原决策重试
- 回退只在 allow 类之间（`allow_always` / `allow_session` → `allow_once`）；`deny_*` 失败永远不会回退成批准
- `--decision` 白名单：只接受 `allow_once` / `allow_session` / `allow_always` / `deny_once` / `deny_always`，拼错或缺值直接报错退出（退出码 2）
- 也支持只看不批的演练模式（`--dry`）

## 运行要求

- Node.js 20.18+（建议 22 LTS）
- 一个 muse.ai 账号（邮箱 + 密码）
- 出网能访问 muse.ai；需要代理时设 `MUSE_PROXY` 环境变量

### 在 Muse App 沙盒里跑？先开这个开关

如果是在 **Muse App 的沙盒环境**里运行（而不是自己电脑/服务器），出网受 App 的权限开关控制：

**设置 → 权限 → 直接网络协议 → 其他 TCP 连接**，必须保持**开启**。

本程序走 HTTPS（443 端口）直连 `muse.ai`，归属"其他 TCP 连接"这一项。**这个开关关了，程序就连不上网——那不是程序的问题，是开关没开。**正式部署在自己机器上跑时不受这个限制，不用管。

## 部署

```bash
git clone https://github.com/caichengle666/muse-auto-approve && cd muse-auto-approve
npm install
# 二选一配凭据（环境变量优先）：
#   A) export MUSE_USER=you@example.com MUSE_PASSWORD=你的密码
#   B) cp data/credentials.json.example data/credentials.json  # 填邮箱和密码，chmod 600
#   （不要一半用环境变量、一半用文件，会被拒绝）
node muse-daemon.cjs --check   # 体检：凭据来源 + 会话剩余天数（本地读取、不出网）
node muse-daemon.cjs --smoke   # 真测一次自动登录链路（会发一封邮件），然后退出
node muse-daemon.cjs           # 常驻守护（10 秒轮询 + allow_always + 会话保活）
```

不想折腾？直接跟 Muse 说"帮我把这个自动审批跑起来"，把邮箱密码通过安全方式告诉它，剩下的它代办。首次启动会自动登录（服务端会往邮箱发一封验证码邮件，**无需读取验证码**），之后 30 天内跑过一次会话就一直有效。

## 会话 cookie 说明

- **要的是哪个 cookie**：`hatch_sess`——muse.ai 登录成功后下发的会话 cookie，有效期 30 天，相当于登录态。
- **存在哪、什么格式**：`data/cookies.json`，内容是一个 JSON 数组，每项四个字段：
  ```json
  [{ "name": "hatch_sess", "value": "这里是会话值", "domain": ".muse.ai", "path": "/" }]
  ```
- **怎么获取（正常情况不用你动手）**：首次启动时自动登录（邮箱 + 密码），程序从登录响应的 `Set-Cookie` 头里解析出 `hatch_sess` 自动写入。之后 daemon 每 5 分钟做一次 token 续期，30 天内跑过一次会话就一直有效；服务端轮换 cookie 后也会自动回写这个文件。
- **手动获取（自动登录失败时的兜底）**：浏览器登录 muse.ai → 按 F12 → Application → Cookies → 找到 `.muse.ai` 域名下的 `hatch_sess` → 复制它的值 → 按上面格式手写 `data/cookies.json`（chmod 600）。
- **安全**：这个文件等同于你的登录态，绝不提交、不外传，`data/` 已在 `.gitignore` 里排除。程序写它时一律 0600、原子写入；文件损坏时会自动重新登录。
- **自动登录不会刷邮件**：只有确定的认证失败才重登——`cookies.json` 不存在/无 `hatch_sess`（`NO_SESSION`）、`cookies.json` 损坏（`BAD_COOKIES`）、token 端点或 `/api/session` 返回 401（`AUTH_FAILED`）。`token 403` 只算瞬时错误：重试 5 次后作废 vmId 缓存重新发现，不触发重登。
- **节流 + 熔断**：两次自动登录至少隔 10 分钟，连续失败后间隔翻倍（20、40 分钟……封顶 6 小时），被节流时日志为 `auto_login_throttled`；状态存 `data/login-state.json`，重启进程也绕不过。连续 5 次失败写 `data/login.blocked` 熔断：daemon 以退出码 3 退出、keepalive 不再拉起、`--check` 会显示"已熔断"。
- **解除熔断**：排查凭据/账号后运行 `node work/login-lib.cjs`（或 `node muse-daemon.cjs --smoke`），登录成功即自动清零失败计数并删除 `data/login.blocked`；也可以手动删掉该文件。凭据缺失/混用不出网、不计入失败。
- 可调环境变量：`MUSE_LOGIN_MIN_GAP_MS`（默认 600000）、`MUSE_LOGIN_MAX_GAP_MS`（默认 21600000）、`MUSE_LOGIN_MAX_FAILS`（默认 5）。

## 常用命令

```bash
node muse-daemon.cjs --once            # 巡检一次审批后退出
node muse-daemon.cjs --once --dry      # 只看不批（演练；常驻守护在跑时也能用）
node muse-daemon.cjs --decision allow_once  # 改策略：只批准本次，不永久放行
node muse-daemon.cjs --no-fallback     # 关掉 allow_once 回退（默认开 --fallback-once）
node work/muse-rpc.cjs list            # 查看审批列表（pending + 最近记录）
node work/muse-rpc.cjs detail <id>     # 单条详情；history [cursor] 看历史
node work/muse-rpc.cjs decide <id> <decision> [reason]  # 手动决策一条
node work/login-lib.cjs                # 强制重新登录（成功即解除登录熔断）
```

daemon 可选参数：`--loop <ms>`（默认 10000）、`--decision <值>`、`--scope <值>`（`allow_always` / `deny_always` 默认 `destination_domain`）、`--always`（= `allow_always + destination_domain`）、`--fallback-once` / `--no-fallback`、`--dry`。`--once` / `--once --dry` / `--check` 不碰 pid 文件，常驻守护在跑时也能用。

注意：`muse-rpc.cjs decide` 是排障用的原样调用——不走白名单校验、不带 `always_scope`；要按 daemon 的形状批准请用 `node muse-daemon.cjs --once`。

退出码：0 正常 / 1 致命错误 / 2 参数或凭据问题（`--decision` 非法、无凭据且无有效会话、凭据来源混用）/ 3 自动登录熔断。

其他环境变量：`MUSE_PROXY`（代理）、`MUSE_VM_ID`（直接指定 vmId，否则读 `data/muse-config.json` 缓存或 `GET /api/session` 自动发现）、`MUSE_DATA_DIR` / `MUSE_LOG_DIR`（覆盖 `data/`、`log/` 位置，供离线测试用，平时不要设——`keepalive.sh` 始终只看项目根目录下的 `data/` 和 `log/`）。

npm 快捷方式：`npm run check` / `npm start` / `npm run once` / `npm run smoke` / `npm run login` / `npm run list` / `npm test`（离线测试）

## 后台常驻

前台 Ctrl+C 即可停止。长期挂机：

- Linux / macOS：`nohup node muse-daemon.cjs >/dev/null 2>&1 &`，或用 `keepalive.sh` + cron 每 15 分钟保活：
  ```
  */15 * * * * /bin/bash /abs/path/to/muse-auto-approve/keepalive.sh >/dev/null 2>&1
  ```
  cron 行用 `/bin/bash` 调用（脚本也自带可执行权限）。脚本会自己找 node：`NODE_BIN` → PATH 里的 `node` → nvm 最高版本（`~/.nvm/versions/node/*/bin/node`）→ `/usr/local/bin/node` 等，找不到时 `log/keepalive.log` 记 `node not found`，在 cron 行写 `NODE_BIN=/abs/path/to/node` 即可。cron 下没有 shell 环境变量：凭据请放 `data/credentials.json`，或项目根目录的 `.env`（`MUSE_USER=…`、`MUSE_PASSWORD=…`、`MUSE_PROXY=…`，chmod 600，已在 `.gitignore`；`.env` 只由 keepalive 读取，手动跑 `node muse-daemon.cjs` 不会读它）。只认本目录的 daemon（别处克隆、编辑器打开该文件、`--once`/`--check`/`--smoke`/`--dry` 都不算存活）；`flock` 防并发（无 flock 时退回 mkdir 锁）；进程在但心跳 `data/muse-daemon.heartbeat` 超过 30 分钟（`MUSE_KEEPALIVE_STALE_SEC`，默认 1800）没更新视为假死，杀掉重拉。拉起时以 `--loop 10000 --always --fallback-once` 启动，stdout 丢弃，stderr 进 `log/daemon-stderr.log`。存在 `data/muse-daemon.stop` 或 `data/login.blocked` 时按设计不拉起。
- Windows：任务计划程序，程序填 `node.exe`，参数填 `muse-daemon.cjs`，起始位置填项目根目录，触发条件选登录时或启动时

停止：在 `data/` 下建一个空文件 `muse-daemon.stop`，守护进程下轮自检时优雅退出，keepalive 也不会再拉起（恢复时删掉它）；或结束 `data/muse-daemon.pid` 里的进程（SIGTERM）。

日志：`log/daemon-log.ndjson`（守护）、`log/auto-approve-log.ndjson`（决策记录）、`log/daemon-stderr.log`，超过 10MB 自动裁到末尾 10MB（启动时和之后每小时检查）；`log/keepalive.log` 自限约 1MB。

## 排障

| 现象 | 原因 / 解决 |
|---|---|
| 退出码 3 / `data/login.blocked` | 连续登录失败熔断：查凭据和账号状态后 `node work/login-lib.cjs`，成功即解除 |
| 日志 `auto_login_throttled` | 自动登录被节流（防刷验证码邮件），到时间会再试，不用处理 |
| 日志 `connect_retry … NO_SESSION` 后紧跟 `auto_login_ok` | 正常自愈；若紧跟 `auto_login_error` 检查凭据 |
| `token 403` | 网络/代理问题或 VM 换了（会自动作废 vmId 缓存重新发现），不会触发重登；检查 `MUSE_PROXY` |
| 退出码 2 + 中文提示 | 无凭据且无有效会话、凭据来源混用，或 `--decision` 非法：按提示修正 |
| keepalive 不拉起 | 看 `log/keepalive.log`：`node not found` 就在 cron 行设 `NODE_BIN`；有 stop / blocked 文件时按设计不拉起 |
| `fetch failed` / 连不上 | 需要代理就设 `MUSE_PROXY`；在 Muse 沙盒里先确认"其他 TCP 连接"开关已开 |
| `sodium-native 未安装` | 运行 `npm install` |

## 重要边界

- **高权限工具**：`allow_always + destination_domain` 会在你的 muse.ai 账号下落成永久规则——新域名的首次外联以后不再经过人眼。只在你自己的账号、自己的机器上用。
- 凭据只存你本地：`data/credentials.json`（chmod 600）或环境变量；密码经 AES-256-GCM 加密后只发往 muse.ai 官方登录接口，不写日志。
- `data/`（凭据/会话）和 `log/` 已在 `.gitignore` 中排除，**绝不要提交**。
- 逆向协议：muse.ai 官方改协议就可能失效，届时 daemon 会不断重连重试，等更新。
- 想全部拒绝而非批准：`--decision deny_always`（危险操作，自行确认；拒绝失败不会回退成批准）。
