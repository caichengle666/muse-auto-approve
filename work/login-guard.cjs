'use strict';
/*
 * 自动登录的节流 / 指数退避 / 连续失败熔断（H3）
 *
 * 每次自动登录都会让服务端发一封验证码邮件，所以：
 *   - 只有"确定的认证失败"才应该触发登录（判定见 needsLogin）；token 403 等瞬时错误只重试，不重登
 *   - 两次登录之间至少间隔 gap = min(MAX_GAP, BASE_GAP * 2^连续失败次数)：10min、20min、40min……封顶 6h
 *   - 连续失败 MAX_FAILS（默认 5）次 -> 写 data/login.blocked 熔断：之后不再自动登录，daemon 以退出码 3 退出，
 *     keepalive 看到该文件也不再拉起。人工排查后运行 `node work/login-lib.cjs`（或 --smoke）成功即自动解除，
 *     也可以手动删掉 data/login.blocked。
 *   - 状态存 data/login-state.json（跨进程共享），keepalive 重启 daemon 也不会绕过节流。
 *   - 凭据缺失 / 混用（NO_CREDENTIALS / MIXED_CREDENTIALS）不出网、不发邮件，不计入失败也不占用节流窗口。
 * 环境变量（可选）：MUSE_LOGIN_MIN_GAP_MS（默认 600000）、MUSE_LOGIN_MAX_GAP_MS（默认 21600000）、MUSE_LOGIN_MAX_FAILS（默认 5）
 */
const fs = require('fs');
const paths = require('./paths.cjs');

const CRED_CODES = new Set(['NO_CREDENTIALS', 'MIXED_CREDENTIALS']);
const AUTH_CODES = new Set(['NO_SESSION', 'BAD_COOKIES', 'AUTH_FAILED']);

/* 是否属于"确定的认证失败"，只有这类错误才值得发邮件重新登录：
 *   NO_SESSION（cookies.json 不存在 / 无 hatch_sess）、BAD_COOKIES（cookies.json 损坏）、
 *   AUTH_FAILED（token 端点或 /api/session 返回 401）。
 * token 403 被 muse-rpc 视为瞬时错误（会重试并刷新 vmId 缓存），不在此列；"forbidden"/"unauthorized" 这类模糊文字也不算。 */
function needsLogin(e) {
  if (!e) return false;
  if (AUTH_CODES.has(e.code)) return true;
  const s = String(e.message || e);
  return /\btoken 401\b|http 401\b|invalid session/i.test(s);
}

function intEnv(name, dflt) { const v = parseInt(process.env[name] || '', 10); return Number.isFinite(v) && v >= 0 ? v : dflt; }

function createLoginGuard(deps = {}) {
  const loginFn = deps.login || ((o) => require('./login-lib.cjs').login(o));
  const resolveCredentials = deps.resolveCredentials || ((o) => require('./login-lib.cjs').resolveCredentials(o));
  const now = deps.now || (() => Date.now());
  const statePath = deps.statePath || paths.LOGIN_STATE_PATH;
  const blockPath = deps.blockPath || paths.LOGIN_BLOCK_PATH;
  const baseGap = deps.baseGapMs != null ? deps.baseGapMs : intEnv('MUSE_LOGIN_MIN_GAP_MS', 10 * 60 * 1000);
  const maxGap = deps.maxGapMs != null ? deps.maxGapMs : intEnv('MUSE_LOGIN_MAX_GAP_MS', 6 * 3600 * 1000);
  const maxFails = deps.maxFails != null ? deps.maxFails : Math.max(1, intEnv('MUSE_LOGIN_MAX_FAILS', 5));

  function readState() {
    try { const j = JSON.parse(fs.readFileSync(statePath, 'utf8')); return { lastAttemptAt: +j.lastAttemptAt || 0, fails: +j.fails || 0 }; }
    catch { return { lastAttemptAt: 0, fails: 0 }; }
  }
  function writeState(st) { try { paths.writeSecret(statePath, JSON.stringify(st)); } catch {} }
  function gapFor(fails) { return Math.min(maxGap, baseGap * Math.pow(2, fails)); }
  function isBlocked() { return fs.existsSync(blockPath); }

  function blockedError() {
    const e = new Error('自动登录已熔断（连续失败过多）：排查凭据/账号后运行 `node work/login-lib.cjs` 或删除 ' + blockPath);
    e.code = 'LOGIN_GIVEUP';
    return e;
  }

  async function login(opts = {}) {
    if (isBlocked()) throw blockedError();
    resolveCredentials({});   // 凭据缺失/混用：直接抛（不出网、不计数）
    const st = readState();
    const gap = gapFor(st.fails);
    const wait = st.lastAttemptAt + gap - now();
    if (st.lastAttemptAt && wait > 0) {
      const e = new Error('login throttled: 距下次允许自动登录还有 ' + Math.ceil(wait / 1000) + 's（连续失败 ' + st.fails + ' 次）');
      e.code = 'LOGIN_THROTTLED';
      e.retryInMs = wait;
      throw e;
    }
    writeState({ lastAttemptAt: now(), fails: st.fails });   // 先记时间再出网：进程中途被杀也不会绕过节流
    try {
      const r = await loginFn(opts);
      writeState({ lastAttemptAt: now(), fails: 0 });
      return r;
    } catch (e) {
      if (e && CRED_CODES.has(e.code)) { writeState(st); throw e; }
      const fails = st.fails + 1;
      writeState({ lastAttemptAt: now(), fails });
      if (fails >= maxFails) {
        try { paths.writeSecret(blockPath, JSON.stringify({ at: now(), fails, lastError: String((e && e.message) || e).slice(0, 300) })); } catch {}
        const g = blockedError();
        g.cause = e;
        throw g;
      }
      throw e;
    }
  }

  /* 人工登录成功后调用：清零失败计数、解除熔断 */
  function reset() {
    writeState({ lastAttemptAt: now(), fails: 0 });
    try { fs.unlinkSync(blockPath); } catch {}
  }

  return { login, reset, readState, isBlocked, gapFor };
}

module.exports = { needsLogin, createLoginGuard, CRED_CODES };
