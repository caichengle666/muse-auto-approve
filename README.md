# muse.ai 全自动审批（Auto-Approve）

> 解放双手，让程序自动帮你永久审批域名通过。

> muse.ai HITL（human-in-the-loop）外联审批的**全自动批准器** —— 纯 Node.js 逆向复刻，无需浏览器。
> 自动登录（零人工，无需读邮箱验证码）→ 会话永续（一次登录、长期有效）→ 实时轮询审批 → 对新单自动 `allow_always`（**永久允许**，落库 durable 规则）→ 断线/失效自愈重连。

## 这是什么

muse.ai 的 Agent VM 发起外联请求（如 `npm`、`curl`）时，若目标未被规则覆盖，会在 UI 弹出审批卡片（HITL）。
本项目通过逆向复刻其客户端与网关协议，把整个流程全自动化：

- **无需浏览器**：登录、token 换发、审批决策全部 Node.js 直连（Noise 加密 WebSocket RPC）
- **零人工登录**：邮箱 + 密码自动登录（服务端要求先触发一次邮件 OTP，但**无需读取验证码**）
- **永久允许**：默认对每条新审批执行 `allow_always + destination_domain`，自动生成 durable 网络规则 —— 同域名以后不再弹单
- **自愈**：会话过期 / cookie 丢失或损坏 → 自动重登（有节流、退避和熔断，不会刷验证码邮件）；网络抖动 → 自动重试；断线 → 自动重连

## 不想折腾？让 Muse 代办

没玩过命令行也行——直接跟 Muse 说：

> "帮我把这个自动审批跑起来"

把你的 muse.ai 邮箱和密码通过安全方式告诉它（别直接发明文聊天），Muse 会帮你装依赖、配凭据、跑体检、拉起常驻。首次启动会自动登录（服务端会往你邮箱发一封验证码邮件，**不用你去读**），之后 30 天内跑过一次，会话就一直有效，不用再管。

## 快速开始

### 0. 前置条件
- **Node.js ≥ 20.18**（建议 22 LTS）
- **网络**：默认直连。若所在网络需要代理才能访问 muse.ai，设置环境变量 `MUSE_PROXY`（如 `MUSE_PROXY=http://127.0.0.1:7890`）即可让所有出网走该代理
- 一个 muse.ai 账号（邮箱 + 密码）

### 1. 安装
```bash
npm install        # 或 npm ci
npm test           # 可选：离线单元测试（不联网、不跑真实守护进程）
```

### 2. 配置凭据（二选一，环境变量优先）
- **[A] 环境变量**：
  ```bash
  MUSE_USER=you@example.com MUSE_PASSWORD=your-password
  ```
- **[B] 文件**：复制 `data/credentials.json.example` 为 `data/credentials.json`，填入邮箱和密码，`chmod 600`。

两个都缺失时会打印配置指引后退出（退出码 2），不会崩溃。
环境变量只设了一半（比如只有 `MUSE_USER`）而另一半在 `credentials.json` 里时，同样报错退出（退出码 2），不会拿两处拼起来的凭据去登录。

### 3. 运行
```bash
node muse-daemon.cjs --check   # 体检：凭据来源 + 会话剩余天数（本地读取、不出网）
node muse-daemon.cjs --smoke   # 真测一次自动登录链路（会发一封邮件），然后退出
node muse-daemon.cjs           # 常驻守护（默认：10s 轮询 + allow_always + 会话保活）
node work/muse-rpc.cjs list    # 查看审批列表（pending + 最近记录）
```

> 首次启动时若 `data/cookies.json` 不存在 → **自动登录**（服务端流程会往邮箱发一封验证码邮件，**无需读取**）→ 建立会话开始工作。
> 之后每 5 分钟自动做一次 token touch 滚动续期：**30 天内跑过一次，会话即永续**，平时不再需要重新登录。

## 目录结构

```
muse-daemon.cjs          # 入口：一体守护进程（登录 + 审批 + 保活 + 自愈）
keepalive.sh             # 保活脚本（cron 调用）：死了/假死就拉起
package.json
test/                    # 离线单元测试（npm test）
work/                    # 代码模块
├── login-lib.cjs        #   自动登录库
├── login-guard.cjs      #   自动登录节流 / 退避 / 熔断
├── decision.cjs         #   审批决策白名单、请求形状、回退规则
├── muse-rpc.cjs         #   Noise-WebSocket RPC 客户端 / CLI
├── muse-noise.cjs       #   Noise XX 协议 + 帧编解码
├── proxy.cjs            #   统一网络层（直连 / 代理）
├── auto-approve.cjs     #   独立自动批准器
└── paths.cjs            #   目录布局定义（三个目录只在这里拼路径）
data/                    # 持久化数据（不进版本库）
├── credentials.json     #   凭据（由 credentials.json.example 复制而来）
├── credentials.json.example
├── cookies.json         #   会话（运行时生成）
├── muse-config.json     #   vmId 缓存（运行时生成）
├── token-last.json      #   最近一次 mint token 的时间（只记时间，token 本身不落盘）
├── login-state.json     #   自动登录节流状态（运行时生成）
├── login.blocked        #   自动登录熔断标记（连续失败过多时生成）
├── muse-daemon.pid      #   进程号（常驻模式运行时生成，退出时删除）
├── muse-daemon.heartbeat#   心跳（主循环每轮更新，keepalive 据此判断假死）
└── *.stop               #   优雅停止标记（需要时手动创建）
log/                     # 日志（不进版本库）
├── daemon-log.ndjson
├── auto-approve-log.ndjson
├── daemon-stderr.log    #   keepalive 拉起时 daemon 的 stderr
└── keepalive.log
```

`data/` 与 `log/` 由 `work/paths.cjs` 在首次运行时自动创建，无需手动建目录（`data/` 新建时权限 0700）。
`cookies.json`、备份、`token-last.json`、`muse-config.json` 等一律以 **0600** 原子写入（先写临时文件再 rename），进程被杀也不会留下半个文件；`cookies.json.bak.*` 只保留最近 2 份。

## 工作原理

```
[凭据: env / data/credentials.json]
     │
     ▼ 自动登录（POST muse.ai/api/auth/native/*）
  hatch_sess cookie（30 天，自动滚动续期）
     │
     ▼ POST /api/hatch/token          (cookie + Sec-Fetch-* 头)
  { token: s0:<JWT>, notary_token }         ← 每次连接现 mint 新 JWT
     │
     ▼ wss://hatch.metaaivm.com/v1/noise?vm_id=…&auth_token=…   (Noise XX 握手，全帧加密)
  Noise 加密通道
     │
     ▼ 加密 RPC 帧
  egress.approvals                     → 拉取 pending 审批列表（含 vmId 自动发现：GET /api/session）
  egress.approval.decide {decision:'allow_always', always_scope:'destination_domain', …}
                                       → 批准 + 永久放行（服务端落库 durable network_rule）
```

逆向要点（详见各文件头部注释）：
- 密码信封 `#PWD_BROWSER:5:<ts>:<b64>` = `crypto_box_seal(AESkey32, 服务端公钥)` + `AES-256-GCM(iv=12×0x00, aad=ts)`；必须先 `send-otp` 再 `confirm-password`
- token 端点要求 `Sec-Fetch-Dest/Mode/Site` 头，缺失直接 403
- Noise 握手：`mixKey` 用 chaining key 做 HKDF key；`split()` 的 ikm 为空数组
- `egress.approvals` 的 `pending` 与 `pending_approvals` 可能同 id 双列，消费端按 id 去重
- vmId 三级解析：`MUSE_VM_ID` 环境变量 → `data/muse-config.json` 缓存 → `GET /api/session` 自动发现（并写入缓存）

## 文件说明

| 文件 | 作用 |
|---|---|
| `muse-daemon.cjs` | **一体守护进程（入口，位于项目根目录）**：自动登录 + 审批轮询 + allow_always + 会话保活 + 自愈（核心） |
| `work/login-lib.cjs` | 自动登录库（可单独运行：`node work/login-lib.cjs` 强制重新登录，成功后解除登录熔断） |
| `work/login-guard.cjs` | 自动登录节流 / 指数退避 / 连续失败熔断 |
| `work/decision.cjs` | 决策值白名单、decide 请求形状、回退规则（daemon 与 auto-approve 共用） |
| `keepalive.sh` | 保活脚本：cron 定时调用，daemon 死了或假死就拉起 |
| `work/muse-rpc.cjs` | Noise-WebSocket RPC 客户端 / CLI（list / detail / history / decide / call / raw） |
| `work/muse-noise.cjs` | Noise XX 协议 + 帧编解码复刻 |
| `work/proxy.cjs` | 统一网络层：未设 `MUSE_PROXY` 时直连，设了则所有出网走该代理 |
| `work/auto-approve.cjs` | 独立自动批准器（daemon 的精简前身；`--once` / `--loop` / `--dry`；不做 token touch、不自动登录，长期挂机请用 daemon） |
| `work/paths.cjs` | 目录布局定义：`work/`（代码）、`data/`（持久化）、`log/`（日志） |

`data/` 存放持久化数据，`log/` 存放日志，两者都在 `.gitignore` 中排除：
`data/cookies.json`（会话）、`data/credentials.json`（凭据）、`data/muse-config.json`（vmId 缓存）、
`log/daemon-log.ndjson`（守护日志）等。

## 常用命令

| 命令 | 作用 |
|---|---|
| `node muse-daemon.cjs --check` | 体检：凭据来源 + 会话剩余天数（本地读取、不出网） |
| `node muse-daemon.cjs --smoke` | 真测一次全自动登录链路（会发一封邮件），然后退出 |
| `node muse-daemon.cjs --once` | 巡检一次审批任务后退出 |
| `node muse-daemon.cjs` | 常驻守护（默认 `--loop 10000 --always --fallback-once`） |
| `node muse-daemon.cjs --once --dry` | 只查看不决策（演练；常驻守护在跑时也能用，`--once` 不碰 pid 文件） |
| `node muse-daemon.cjs --decision allow_once` | 改决策策略（如只批准本次） |
| `node work/muse-rpc.cjs list` | 审批列表 |
| `node work/muse-rpc.cjs detail <id>` / `history` | 单条详情 / 历史 |
| `node work/muse-rpc.cjs decide <id> <decision>` | 手动决策一条 |
| `node work/login-lib.cjs` | 强制重新登录 |

也可用 npm scripts：`npm run check` / `npm start` / `npm run once` / `npm run smoke` / `npm run login` / `npm run list` / `npm test`。

### 决策策略说明
- 默认 `allow_always + destination_domain`：每遇一个新域名自动**永久放行**（服务端落库 `durable network_rule`）。个别被服务端**明确拒绝**（HTTP 4xx/5xx、`{ok:false}`、rpc error）的单会回退为 `allow_once`（`--fallback-once`），不卡流程；超时/断线这类不确定是否已生效的失败不回退，下一轮若仍 pending 会按原决策重试。
- `--decision` 只接受 `allow_once` / `allow_session` / `allow_always` / `deny_once` / `deny_always`，拼错或缺值直接退出（退出码 2）。
- 回退只在 allow 类决策之间进行（`allow_always` / `allow_session` → `allow_once`）；**`deny_*` 失败永远不会回退成 allow**。
- 读者授权类（reader grant）审批的永久 scope 用 `entity`；当前默认按 `destination_domain` 尝试、必要时回退，如遇此类场景可自行调整策略。

## 自愈与保活

- **会话保活**：每 5 分钟一次 token touch，`hatch_sess`（30 天）自动滚动换发 → 长期运行时窗口无限续期。
- **登录自愈**：只有**确定的认证失败**才自动全链登录（发 1 封邮件，无需读码）→ 重连继续：`cookies.json` 不存在 / 无 `hatch_sess`（`NO_SESSION`）、`cookies.json` 损坏（`BAD_COOKIES`）、token 端点或 `/api/session` 返回 401（`AUTH_FAILED`）。日志中出现 `connect_retry … NO_SESSION` 后紧跟 `auto_login_ok` 属正常自愈路径。
  - `token 403` 视为瞬时错误：重试 5 次，仍失败就作废 vmId 缓存、下次重新 `GET /api/session` 发现（VM 换了也能恢复），**不触发重登**。
  - **节流 + 退避**：两次自动登录至少间隔 10 分钟，连续失败后间隔翻倍（20、40 分钟……封顶 6 小时）；被节流时日志为 `auto_login_throttled`。状态存 `data/login-state.json`，重启进程也不会绕过。
  - **熔断**：连续 5 次登录失败 → 写 `data/login.blocked`，daemon 以**退出码 3** 退出，keepalive 不再拉起。排查凭据/账号后运行 `node work/login-lib.cjs`（或 `--smoke`）成功即自动解除，也可手动删除该文件。
  - 可用环境变量调整：`MUSE_LOGIN_MIN_GAP_MS`、`MUSE_LOGIN_MAX_GAP_MS`、`MUSE_LOGIN_MAX_FAILS`。
- **网络自愈**：连接抖动自动重试；WebSocket 断开自动重连（连续失败时退避 5 秒起、封顶 5 分钟）。所有出网请求都有超时，网络黑洞不会让进程永久挂起；连接断开后的 RPC 立即报错而不是白等超时。
- 日志：`log/daemon-log.ndjson`（守护）+ `log/auto-approve-log.ndjson`（决策记录）。
- **日志上限**：守护进程启动时和之后每小时检查一次 `daemon-log.ndjson`、`auto-approve-log.ndjson`、`daemon-stderr.log`，超过 **10MB** 就裁到末尾 10MB（整行保留，不会截断半行）；`keepalive.log` 由 keepalive 自己限制在约 1MB。keepalive 拉起时 daemon 的 stdout 直接丢弃（与 `daemon-log.ndjson` 完全重复）。

## 后台常驻

前台运行时 Ctrl+C 即可停止；需要长期挂机时把进程放到后台：

- Linux / macOS：`nohup node muse-daemon.cjs --loop 10000 --always --fallback-once >/dev/null 2>&1 &`
- Linux 推荐用 `keepalive.sh` + cron 保活（脚本已带可执行权限）：
  ```
  */15 * * * * /bin/bash /abs/path/to/muse-auto-approve/keepalive.sh >/dev/null 2>&1
  ```
  - cron 的 PATH 很精简：脚本会依次找 `NODE_BIN` → PATH 里的 `node` → nvm 安装的最高版本（`~/.nvm/versions/node/*/bin/node`）→ `/usr/local/bin/node` 等；也可以在 cron 行里写死 `NODE_BIN=/abs/path/to/node`。
  - cron 里没有你 shell 的环境变量：凭据请用 `data/credentials.json`，或在项目根目录放 `.env`（`MUSE_USER=…`、`MUSE_PASSWORD=…`、`MUSE_PROXY=…`，`chmod 600`，已在 `.gitignore` 中）。
  - 只认本目录的 daemon（别处的克隆、编辑器打开该文件、`--once` 巡检都不算存活）；`flock` 防并发；进程在但心跳 `data/muse-daemon.heartbeat` 超过 30 分钟（`MUSE_KEEPALIVE_STALE_SEC`）没更新视为假死，杀掉重拉。
- Windows：用「任务计划程序」新建任务，程序填 `node.exe`，参数填 `muse-daemon.cjs --loop 10000 --always --fallback-once`，起始位置填项目根目录；触发条件选「用户登录时」或「系统启动时」。

## 停止

- 写 `data/muse-daemon.stop` 文件（守护进程下轮自检时优雅退出；**keepalive 看到该文件也不会再拉起**，想恢复运行时删掉它）
- 或结束 `data/muse-daemon.pid` 中记录的进程（SIGTERM）/ 直接 Ctrl+C（前台运行时）

## 故障排查

| 现象 | 原因 / 解决 |
|---|---|
| `token 403` | 缺 `Sec-Fetch-*` 请求头（本代码已内置）、网络不通，或 VM 换了（会自动作废 vmId 缓存重新发现）；检查 `MUSE_PROXY` 是否可用。403 不会触发重登 |
| 日志 `invalid session … (ENOENT)` / `cookies.json corrupt` | 正常自愈入口：随后应有 `auto_login_ok`；若紧跟 `auto_login_error` 检查凭据 |
| 日志 `auto_login_throttled` | 自动登录被节流（防止刷验证码邮件），到时间会再试 |
| 退出码 3 / `data/login.blocked` | 连续登录失败熔断：检查凭据、账号状态后运行 `node work/login-lib.cjs`，成功即解除 |
| 退出码 2 + 中文提示 | 未配置凭据且无有效会话、凭据来源混用，或 `--decision` 非法：按提示修正 |
| keepalive 不拉起 | 看 `log/keepalive.log`：`node not found` 请在 cron 行设 `NODE_BIN`；存在 `data/muse-daemon.stop` 或 `data/login.blocked` 时按设计不拉起 |
| `fetch failed` / 连不上 | 网络不可达：若需代理请设置 `MUSE_PROXY`（如 `http://127.0.0.1:7890`）；直连环境请确认可正常访问 muse.ai |
| `sodium-native 未安装` | 运行 `npm install`（需要本机具备编译工具链或可用预编译包） |
| 想全部拒绝而非批准 | `--decision deny_always`（危险操作，自行确认；拒绝失败不会回退成批准） |

## 免责声明

本项目为协议逆向与自动化研究用途，仅对本账号自己的审批流生效。请遵守 muse.ai 的服务条款，自行评估使用风险；因使用本项目造成的任何后果由使用者自负。