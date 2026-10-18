'use strict';
/*
 * muse.ai 一体化守护进程 v2：自动登录 + 全自动审批（allow_always 永久允许）
 *
 * 用法:
 *   node muse-daemon.cjs                 # 常驻（默认 --loop 10000 --always --fallback-once）
 *   node muse-daemon.cjs --once          # 一次巡检
 *   node muse-daemon.cjs --check         # 体检：凭据来源 + 会话状态（本地读取、不出网）
 *   node muse-daemon.cjs --smoke         # 真测一次全自动登录链路（会发一封验证码邮件），然后退出
 *   可选: --loop <ms> / --decision xxx / --scope xxx / --fallback-once / --no-fallback / --dry
 *   --decision 只接受 allow_once / allow_session / allow_always / deny_once / deny_always，拼错或缺值退出码 2。
 *
 * 凭据: 环境变量 MUSE_USER / MUSE_PASSWORD 优先；其次 data/credentials.json；
 *       两者都没有且无会话 -> 打印友好提示后退出（退出码 2），不会崩溃。
 * 行为:
 *   1) 会话保活: 每 5 分钟 token touch（轮换 hatch_sess 写回 cookies.json => 30 天窗口永续）
 *   2) 审批轮询: 每 interval 扫 egress.approvals -> 对 pending 单发 allow_always(destination_domain)
 *      --fallback-once：allow_always / allow_session 被服务端明确拒绝时回退 allow_once；deny_* 永不回退成 allow，
 *      超时/断线（结果未知）也不回退，下一轮仍 pending 时按原决策再试
 *   3) 自愈: cookie 文件丢失/损坏 / 会话确定失效（401）-> 自动全链登录（发 1 封邮件，无需读码）-> 重连继续
 *      自动登录有节流 + 指数退避（10min 起、封顶 6h）+ 连续 5 次失败熔断（data/login.blocked，退出码 3），见 work/login-guard.cjs
 *
 * 日志: log/daemon-log.ndjson + log/auto-approve-log.ndjson（decide 记录同格式），每小时检查、超过 10MB 裁剪
 * 停止: 写 data/muse-daemon.stop 或 Ctrl+C / SIGTERM
 * 退出码: 0 正常 / 1 致命错误 / 2 参数或凭据问题 / 3 自动登录熔断
 */
const fs = require('fs');
const paths = require('./work/paths.cjs');
const { installProxy, getProxy } = require('./work/proxy.cjs');
installProxy();
const { login, resolveCredentials } = require('./work/login-lib.cjs');
const { DECISIONS, takeValue, validateDecision, buildDecideParams, shouldFallback } = require('./work/decision.cjs');
const { needsLogin, createLoginGuard, CRED_CODES } = require('./work/login-guard.cjs');

const DLOG = paths.DAEMON_LOG_PATH;
const ALOG = paths.AUTO_APPROVE_LOG_PATH;
const STOP = paths.DAEMON_STOP_PATH;
const PIDF = paths.DAEMON_PID_PATH;
const COOKIE_PATH = paths.COOKIE_PATH;
const HEARTBEAT = paths.DAEMON_HEARTBEAT_PATH;
const STDERR_LOG = paths.DAEMON_STDERR_PATH;   // keepalive 把 stderr 重定向到这里（stdout 丢弃，因为与 daemon-log.ndjson 完全重复）
const TOUCH_MS = 5 * 60 * 1000;
const LOG_TRIM_MS  = 60 * 60 * 1000;      // 每小时检查一次日志体积
const LOG_MAX_BYTES = 10 * 1024 * 1024;   // 单文件超过 10MB 触发裁剪，裁剪后保留末尾 ≤ 10MB

function log(obj, toAlog) {
  const line = JSON.stringify({ ts: Date.now(), ...obj });
  try { fs.appendFileSync(DLOG, line + '\n'); } catch {}
  if (toAlog) { try { fs.appendFileSync(ALOG, line + '\n'); } catch {} }
  console.log(line);
}

/* 日志裁剪：单文件超过 maxBytes 时保留末尾若干整行、总量压回上限内。
 * inPlace=false（默认）：写临时文件再 rename，适合每次 append 都重新打开文件的 ndjson 日志；
 * inPlace=true：原地重写，适合被 shell `>>` 长期持有 O_APPEND 句柄的文件（rename 后句柄会继续写进旧 inode）。 */
function trimLog(file, maxBytes = LOG_MAX_BYTES, inPlace = false) {
  try {
    const st = fs.statSync(file);
    if (st.size <= maxBytes) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    // 从末尾向前累加，直到再加一行就超过上限为止（保证裁剪后 ≤ 10MB，而不是固定行数）
    const kept = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(lines[i], 'utf8') + 1;
      if (bytes + lineBytes > maxBytes) break;
      kept.push(lines[i]);
      bytes += lineBytes;
    }
    kept.reverse();
    const out = kept.length ? kept.join('\n') + '\n' : '';
    if (inPlace) fs.writeFileSync(file, out);
    else {
      const tmp = file + '.trim' + process.pid;
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, file);
    }
    console.error(`[log-trim] ${file} 已裁剪（保留末 ${kept.length} 行，约 ${Math.round(bytes / 1024 / 1024 * 10) / 10}MB）`);
    return true;
  } catch { return false; }
}

/* 会话体检（本地读取，不出网） */
function daysText(st) { return st.expiresInDays != null ? ('hatch_sess 约剩 ' + st.expiresInDays + ' 天') : 'hatch_sess 有效（过期时间未能从 token 解析，按 30 天计）'; }
function sessionStatus() {
  const out = { cookieFile: false, session: false, expiresInDays: null, expired: null };
  let list;
  try { list = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8')); } catch { return out; }
  out.cookieFile = true;
  const c = Array.isArray(list) ? list.find(x => x && x.name === 'hatch_sess') : null;
  if (c && typeof c.value === 'string' && c.value.length > 10) {
    out.session = true;
    try {
      const b64 = String(c.value).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      if (payload && payload.exp) {
        const secs = payload.exp - Math.floor(Date.now() / 1000);
        out.expiresInDays = Math.round(secs / 8640) / 10;
        out.expired = secs <= 0;
      }
    } catch {}
  }
  return out;
}

function parseArgs(argv) {
  const a = { mode: 'loop', interval: 10000, decision: 'allow_always', scope: 'destination_domain', fallbackOnce: true, dry: false, check: false, smoke: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--once') a.mode = 'once';
    else if (v === '--check') a.check = true;
    else if (v === '--smoke') a.smoke = true;
    else if (v === '--loop') { a.mode = 'loop'; if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) a.interval = parseInt(argv[++i], 10); }
    else if (v === '--decision') a.decision = takeValue(argv, i++, '--decision');
    else if (v === '--always') { a.decision = 'allow_always'; if (!a.scope) a.scope = 'destination_domain'; }
    else if (v === '--scope') a.scope = takeValue(argv, i++, '--scope');
    else if (v === '--fallback-once') a.fallbackOnce = true;
    else if (v === '--no-fallback') a.fallbackOnce = false;
    else if (v === '--dry') a.dry = true;
  }
  validateDecision(a.decision);
  if ((a.decision === 'allow_always' || a.decision === 'deny_always') && !a.scope) a.scope = 'destination_domain';
  return a;
}

async function sweep(conn, opts, rpc) {
  let list;
  try { list = await rpc.rpcCall(conn, 'egress.approvals', {}); }
  catch (e) { log({ event: 'list_error', error: e.message }, true); throw e; }
  const pending = (list && list.pending) || [];
  const pa = (list && list.pending_approvals) || [];
  const ids = new Set([...pending.map(p => p.approval_id), ...pa.map(p => p.approval_id)].filter(Boolean));
  if (ids.size === 0) { log({ event: 'heartbeat', pending: 0 }, true); return 0; }
  log({ event: 'pending_found', count: ids.size, ids: [...ids] }, true);
  let done = 0;
  for (const id of ids) {
    if (opts.dry) { log({ event: 'dry_skip', approval_id: id }, true); continue; }
    try {
      const r = await rpc.rpcCall(conn, 'egress.approval.decide', buildDecideParams(id, opts));
      const a = (r && r.approval) || {};
      log({ event: 'decided', approval_id: id, decision: opts.decision, scope: opts.scope, status: a.status, applied_rules: Array.isArray(a.applied_rule_entries) ? a.applied_rule_entries.length : null }, true);
      done++;
    } catch (e) {
      log({ event: 'decide_error', approval_id: id, error: e.message, status: e.status || null }, true);
      if (shouldFallback(opts, e)) {
        try {
          const r2 = await rpc.rpcCall(conn, 'egress.approval.decide', { approval_id: id, decision: 'allow_once' });
          log({ event: 'decided_fallback', approval_id: id, status: ((r2 && r2.approval) || {}).status }, true);
          done++;
        } catch (e2) { log({ event: 'fallback_error', approval_id: id, error: e2.message }, true); }
      }
    }
  }
  return done;
}

/* 网络模式 -> 传给 installProxy / rpc.connect 的代理参数：direct 强制直连（null），proxy 用启动时的 MUSE_PROXY */
function proxyFor(mode, rawProxy) { return mode === 'direct' ? null : (rawProxy || null); }

let loginGuard = null;
function getLoginGuard() { return loginGuard || (loginGuard = createLoginGuard({ login })); }

/* 需要登录时走节流后的登录；成功返回 true。凭据问题 / 熔断向上抛，节流或失败返回 false（调用方不再无谓重试） */
async function healLogin() {
  try {
    const r = await getLoginGuard().login({ log: m => log({ event: 'login', msg: m }) });
    log({ event: 'auto_login_ok', frlAccountId: r.frlAccountId, credentialSource: r.source });
    return true;
  } catch (e2) {
    log({ event: e2.code === 'LOGIN_THROTTLED' ? 'auto_login_throttled' : 'auto_login_error', error: e2.message, code: e2.code || null });
    if (CRED_CODES.has(e2.code) || e2.code === 'LOGIN_GIVEUP') throw e2;
    return false;
  }
}

/* 带自愈的连接：确定的认证失败（无/损坏 cookie、401）走节流登录；网络抖动 / token 403 直接重试（不重登）
 * 平台适配（2026-10-06）：
 * 1) 每次尝试前重装代理（installProxy 内部实时重读 MUSE_PROXY），因为本沙箱出口代理
 *    凭据数分钟轮换，长驻进程沿用启动时凭据会导致 WS 握手 401/挂起；
 * 2) MUSE_PROXY 指向沙箱出口代理（hatch-egress-proxy）时，该代理建 WS 极不可靠，
 *    而直连已实测可用，因此优先直连、失败再回退走代理；MUSE_PROXY 指向其他地址
 *    （用户自建代理）或未设置时，保持原版行为不变。
 * 模式通过参数传给 installProxy / rpc.connect，不修改 process.env.MUSE_PROXY（以后重连仍能回退到代理）。
 * 返回 conn，conn.mode 记录本次连上用的模式（后续 token touch 沿用同一模式）。 */
async function connectWithHeal(rpc) {
  const rawProxy = (process.env.MUSE_PROXY || '').trim();
  const sandboxProxy = /hatch-egress-proxy/.test(rawProxy);
  const modes = sandboxProxy ? ['direct', 'proxy'] : ['proxy'];
  let lastErr = null;
  for (const mode of modes) {
    for (let i = 1; i <= 4; i++) {
      const px = proxyFor(mode, (process.env.MUSE_PROXY || '').trim() || rawProxy);   // 每次实时重读（凭据轮换）
      installProxy(px);
      try { const conn = await rpc.connect({ proxy: px }); conn.mode = mode; return conn; }
      catch (e) {
        lastErr = e;
        log({ event: 'connect_retry', attempt: i, mode, error: e.message, code: e.code || null });
        if (needsLogin(e)) {
          // 认证问题与网络模式无关：登录不成（节流/失败）就直接放弃本轮，交给主循环退避，不再换模式空转
          if (!(await healLogin())) throw e;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    log({ event: 'connect_mode_failed', mode });
  }
  throw lastErr;
}

/* pid 文件里记录的进程是否真是 muse-daemon（防 PID 复用误判，L2）；没有 /proc 的系统退回 kill(pid,0) */
function isDaemonPid(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try { return /muse-daemon/.test(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')); }
  catch { return !fs.existsSync('/proc/self'); }
}

function touchHeartbeat() {
  try { const t = new Date(); fs.utimesSync(HEARTBEAT, t, t); }
  catch { try { fs.writeFileSync(HEARTBEAT, String(process.pid)); } catch {} }
}

function reconnectDelay(fails) { return Math.min(5 * 60 * 1000, 5000 * Math.pow(2, Math.max(0, fails - 1))); }

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { if (e.code === 'BAD_ARGS') { console.error(e.message); process.exit(2); } throw e; }

  /* ---- 体检模式：只本地读，不出网，不写 pid ---- */
  if (opts.check) {
    let credInfo = null, credErr = null;
    try { const c = resolveCredentials({}); credInfo = { email: c.email, source: c.source }; }
    catch (e) { credErr = e; }
    const st = sessionStatus();
    const blocked = fs.existsSync(paths.LOGIN_BLOCK_PATH);
    const srcMap = { env: '环境变量 MUSE_USER/MUSE_PASSWORD', file: 'data/credentials.json', mixed: '环境变量+文件混合（可能不完整）', argument: '命令行参数' };
    console.log('--- muse-daemon 体检（本地，不出网） ---');
    console.log('网络: ' + (getProxy() ? '经代理 ' + getProxy().replace(/:([^:@/]+)@/, ':***@') : '直连（未设置 MUSE_PROXY）'));
    if (credInfo) console.log('凭据: OK (' + credInfo.email + '，来源: ' + (srcMap[credInfo.source] || credInfo.source) + ')');
    else console.log('凭据: ' + (credErr && credErr.code === 'NO_CREDENTIALS' ? '缺失 (无环境变量且无 credentials.json)' : '有问题 (' + credErr.message + ')'));
    console.log('会话: ' + (!st.cookieFile ? '无 cookies.json（需要自动登录）'
      : !st.session ? 'cookies.json 存在但无 hatch_sess（需要自动登录）'
      : st.expired ? 'hatch_sess 已过期（需要自动登录）'
      : 'OK（' + daysText(st) + '）'));
    if (blocked) console.log('自动登录: 已熔断（连续失败过多）—— 排查后运行 node work/login-lib.cjs 解除，或删除 ' + paths.LOGIN_BLOCK_PATH);
    const ok = !!credInfo || (st.session && !st.expired);
    console.log('结论: ' + (ok
      ? '可以启动（node muse-daemon.cjs）' + (!credInfo ? ' —— 注意：当前仅靠现有会话运行，建议尽快配置凭据' : '')
      : '无法全自动启动 —— 请配置凭据（见上）或先运行 node work/login-lib.cjs'));
    process.exit(ok ? 0 : 2);
  }

  /* ---- smoke：真跑一次全自动登录链路（会发一封邮件），然后退出 ---- */
  if (opts.smoke) {
    log({ event: 'smoke_start' });
    try {
      const r = await login({ log: m => log({ event: 'login', msg: m }) });
      log({ event: 'smoke_ok', frlAccountId: r.frlAccountId, credentialSource: r.source });
      try { getLoginGuard().reset(); } catch {}   // 人工验证成功：解除登录熔断
      console.log('SMOKE OK: 登录链路全通（凭据来源: ' + r.source + '）。');
      process.exit(0);
    } catch (e) {
      log({ event: 'smoke_error', error: e.message, code: e.code || null });
      if (CRED_CODES.has(e.code)) { console.error('\n' + e.message + '\n'); process.exit(2); }
      console.error('SMOKE FAIL:', e.message); process.exit(1);
    }
  }

  /* ---- pid-guard：仅常驻模式（--once / --dry 巡检可以和常驻守护同时跑，也不碰 pid 文件） ---- */
  if (opts.mode === 'loop') {
    try {
      const old = parseInt(fs.readFileSync(PIDF, 'utf8'), 10);
      if (old && old !== process.pid && isDaemonPid(old)) {
        console.error('another muse-daemon is already running: pid ' + old + ' -> exit');
        process.exit(0);
      }
    } catch {}
  }

  /* ---- 登录熔断：之前连续登录失败过多，不再自动登录（避免刷验证码邮件） ---- */
  if (fs.existsSync(paths.LOGIN_BLOCK_PATH)) {
    console.error('自动登录已熔断（' + paths.LOGIN_BLOCK_PATH + ' 存在）：连续登录失败过多。排查凭据/账号后运行 node work/login-lib.cjs（成功即解除）或删除该文件。');
    process.exit(3);
  }

  /* ---- 启动体检：无凭据且无会话 -> 友好提示退出（而不是崩溃） ---- */
  {
    let credOk = false, credEmail = '', credSource = '';
    try { const c = resolveCredentials({}); credOk = true; credEmail = c.email; credSource = c.source; }
    catch (e) {
      if (e.code === 'MIXED_CREDENTIALS') { console.error('\n' + e.message + '\n'); process.exit(2); }
      if (e.code !== 'NO_CREDENTIALS') throw e;
      const st = sessionStatus();
      if (st.session && !st.expired) {
        console.log('提示: 未配置登录凭据，但检测到有效会话（' + daysText(st) + '），仍可直接运行。');
      } else {
        console.error('\n==================== 无法启动 ====================');
        console.error('没有可用的登录凭据，也没有有效会话 cookie（' + (st.cookieFile ? 'hatch_sess 缺失或已过期' : 'cookies.json 不存在') + '）。');
        console.error('请任选其一配置后重试：');
        console.error('  [A] 环境变量:  MUSE_USER=你的邮箱   MUSE_PASSWORD=你的密码');
        console.error('  [B] 文件:      ' + paths.CRED_PATH);
        console.error('                内容: {"email":"你的邮箱","password":"你的密码"}');
        console.error('');
        console.error('说明: 自动登录会往邮箱发一封验证码邮件（无需读取）；30 天内登录过一次后会话自动永续，');
        console.error('      平时不再需要重新登录。配置好后运行:  node muse-daemon.cjs');
        console.error('==================================================\n');
        process.exit(2);
      }
    }
    if (credOk) console.log('凭据就绪（' + credEmail + '，来源: ' + credSource + '）。');
  }
  if (opts.mode === 'loop') {
    try { fs.writeFileSync(PIDF, String(process.pid)); } catch {}
    // 退出时删掉自己的 pid 文件（只删内容仍是自己 pid 的，不误删后来者的）
    process.on('exit', () => { try { if (parseInt(fs.readFileSync(PIDF, 'utf8'), 10) === process.pid) fs.unlinkSync(PIDF); } catch {} });
  }

  log({ event: 'daemon_start', mode: opts.mode, interval: opts.interval, decision: opts.decision, scope: opts.scope, fallbackOnce: opts.fallbackOnce, pid: process.pid, proxy: (getProxy() || 'direct').replace(/:([^:@/]+)@/, ':***@') });
  const rpc = require('./work/muse-rpc.cjs');
  let conn = await connectWithHeal(rpc);
  log({ event: 'connected', pid: process.pid });
  if (opts.mode === 'once') {
    const n = await sweep(conn, opts, rpc);
    log({ event: 'once_done', decided: n });
    try { conn.ws.close(); } catch {}
    process.exit(0);
  }
  let stopped = false;
  const onSig = (sig) => () => { stopped = true; log({ event: sig.toLowerCase() }); try { conn.ws.close(); } catch {} process.exit(0); };
  process.on('SIGINT', onSig('SIGINT'));
  process.on('SIGTERM', onSig('SIGTERM'));
  let lastTouch = Date.now();  // connect() 刚 mint 过 token，无需立刻再 touch
  let lastTrim  = 0;           // 日志裁剪计时器（启动时先检查一次）
  let reconnectFails = 0;
  const rawProxy = (process.env.MUSE_PROXY || '').trim();
  while (!stopped) {
    if (fs.existsSync(STOP)) { log({ event: 'stop_file' }); break; }
    touchHeartbeat();   // keepalive 据此判断是否假死
    // 日志裁剪（每小时一次，防长期运行撑满磁盘）
    if (Date.now() - lastTrim > LOG_TRIM_MS) {
      lastTrim = Date.now();
      trimLog(DLOG); trimLog(ALOG); trimLog(STDERR_LOG, LOG_MAX_BYTES, true);
    }
    if (conn && Date.now() - lastTouch > TOUCH_MS) {
      try { installProxy(proxyFor(conn.mode, (process.env.MUSE_PROXY || '').trim() || rawProxy)); await rpc.mintToken(); lastTouch = Date.now(); log({ event: 'session_touch_ok' }); }
      catch (e) {
        log({ event: 'session_touch_error', error: e.message, code: e.code || null });
        if (needsLogin(e)) {
          try { if (await healLogin()) lastTouch = Date.now(); }
          catch (e2) { if (e2.code === 'LOGIN_GIVEUP') throw e2; }
        }
      }
    }
    try {
      if (!conn) throw new Error('not connected');
      await sweep(conn, opts, rpc);
      reconnectFails = 0;
    } catch (e) {
      log({ event: 'sweep_error', error: e.message });
      try { conn && conn.ws.close(); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      try { conn = await connectWithHeal(rpc); reconnectFails = 0; lastTouch = Date.now(); log({ event: 'reconnected', mode: conn.mode }); }
      catch (e2) {
        if (e2.code === 'LOGIN_GIVEUP' || CRED_CODES.has(e2.code)) throw e2;
        conn = null;
        reconnectFails++;
        const d = reconnectDelay(reconnectFails);   // 5s、10s、20s……封顶 5 分钟
        log({ event: 'reconnect_error', error: e2.message, code: e2.code || null, fails: reconnectFails, retryInMs: d });
        await new Promise(r => setTimeout(r, d));
      }
    }
    await new Promise(r => setTimeout(r, opts.interval));
  }
  try { conn && conn.ws.close(); } catch {}
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => {
    if (e && CRED_CODES.has(e.code)) { console.error('\n' + e.message + '\n'); process.exit(2); }
    if (e && e.code === 'LOGIN_GIVEUP') { log({ event: 'login_giveup', error: e.message }); console.error('LOGIN GIVEUP:', e.message); process.exit(3); }
    console.error('DAEMON FATAL:', (e && e.message) || e);
    process.exit(1);
  });
}

module.exports = { parseArgs, buildDecideParams, needsLogin, sweep, connectWithHeal, trimLog, sessionStatus, isDaemonPid, reconnectDelay, proxyFor, DECISIONS };
