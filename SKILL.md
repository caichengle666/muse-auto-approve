# muse-auto-approve

> 解放双手，让程序自动帮你永久审批域名通过。

muse.ai 外联审批（HITL 审批卡片）的全自动批准器：纯 Node.js 逆向复刻 muse.ai 客户端协议，无需浏览器——自动登录 → 会话长期有效 → 每 10 秒轮询待审批单 → 自动批准。

## 适用场景

- muse.ai 里 Agent 每次访问新网站都要手动点审批，想彻底解放双手
- 默认策略：`allow_always + destination_domain`——新域名首次自动永久放行，落库为 durable 规则，以后不再弹窗
- 也支持只看不批的演练模式（`--dry`）

## 运行要求

- Node.js 20.18+（建议 22 LTS）
- 一个 muse.ai 账号（邮箱 + 密码）
- 出网能访问 muse.ai；需要代理时设 `MUSE_PROXY` 环境变量

## 部署

```bash
git clone https://github.com/caichengle666/muse-auto-approve && cd muse-auto-approve
npm install
# 二选一配凭据（环境变量优先）：
#   A) export MUSE_USER=you@example.com MUSE_PASSWORD=你的密码
#   B) cp data/credentials.json.example data/credentials.json  # 填邮箱和密码，chmod 600
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
- **安全**：这个文件等同于你的登录态，绝不提交、不外传，`data/` 已在 `.gitignore` 里排除。

## 常用命令

```bash
node muse-daemon.cjs --once            # 巡检一次审批后退出
node muse-daemon.cjs --once --dry      # 只看不批（演练）
node muse-daemon.cjs --decision allow_once  # 改策略：只批准本次，不永久放行
node work/muse-rpc.cjs list            # 查看审批列表
node work/muse-rpc.cjs decide <id> <decision>  # 手动决策一条
node work/login-lib.cjs                # 强制重新登录
```

npm 快捷方式：`npm run check` / `npm start` / `npm run once` / `npm run smoke` / `npm run login` / `npm run list`

## 后台常驻

前台 Ctrl+C 即可停止。长期挂机：

- Linux / macOS：`nohup node muse-daemon.cjs >/dev/null 2>&1 &`，或用 `keepalive.sh` + cron 每 15 分钟保活
- Windows：任务计划程序，程序填 `node.exe`，参数填 `muse-daemon.cjs`，起始位置填项目根目录，触发条件选登录时或启动时

停止：在 `data/` 下建一个空文件 `muse-daemon.stop`，守护进程下轮自检时优雅退出；或直接结束进程。

## 重要边界

- **高权限工具**：`allow_always + destination_domain` 会在你的 muse.ai 账号下落成永久规则——新域名的首次外联以后不再经过人眼。只在你自己的账号、自己的机器上用。
- 凭据只存你本地：`data/credentials.json`（chmod 600）或环境变量；密码经 AES-256-GCM 加密后只发往 muse.ai 官方登录接口，不写日志。
- `data/`（凭据/会话）和 `log/` 已在 `.gitignore` 中排除，**绝不要提交**。
- 逆向协议：muse.ai 官方改协议就可能失效，届时 daemon 会不断重连重试，等更新。
- 想全部拒绝而非批准：`--decision deny_always`（危险操作，自行确认）。
