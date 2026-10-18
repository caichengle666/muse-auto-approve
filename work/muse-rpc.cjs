'use strict';
/*
 * muse.ai RPC over Noise WebSocket — Node 复刻 CLI
 *
 * 用法:
 *   node work/muse-rpc.cjs list                       # 拉审批列表 egress.approvals
 *   node work/muse-rpc.cjs detail <approval_id>
 *   node work/muse-rpc.cjs decide <approval_id> <decision> [reason]
 *   node work/muse-rpc.cjs call <method> <json-params> # 任意 RPC（路径需在其路由表中）
 *   node work/muse-rpc.cjs raw <json-spec>             # 发自定义请求（排障用）
 *
 * 数据文件: data/cookies.json      (必填: 至少含 hatch_sess；由 login-lib 自动维护)
 *          data/muse-config.json (可选缓存: {vmId,vmName}；缺失时自动从 /api/session 发现，或设 MUSE_VM_ID)
 * 两者均位于项目根目录下的 data/（首次运行自动创建）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { installProxy, createWS } = require('./proxy.cjs');
installProxy();
const { NoiseXXInitiator, NoiseTransport, te, pbVarint, pbBytes, pbString, pbRead, pbGet, pbConcatFields } = require('./muse-noise.cjs');

const paths = require('./paths.cjs');
const COOKIE_PATH = paths.COOKIE_PATH;
const CONFIG_PATH = paths.VM_CONFIG_PATH;
const TOKEN_PATH = paths.TOKEN_PATH;
const APP_ID = 'hatch-web';
let VM_ID = process.env.MUSE_VM_ID || null;   // 支持环境变量直接指定
let VM_NAME = null;
let VM_SOURCE = VM_ID ? 'env' : null;          // env | cache | discovered
let SKIP_VM_CACHE = false;                     // token 持续 403 后置位：下次不读缓存，直接重新发现

/* 带分类信息的错误：status 是 HTTP 状态；code 供上层判断是否需要重登（见 login-guard.needsLogin） */
function httpError(msg, status, code) { const e = new Error(msg); e.status = status; if (code) e.code = code; return e; }

/* vmId 解析（懒加载）: ① MUSE_VM_ID 环境变量 ② data/muse-config.json 缓存 ③ GET /api/session 自动发现（发现后写入缓存） */
async function discoverVmId() {
  if (VM_ID) return;
  if (!SKIP_VM_CACHE) {
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (c && c.vmId) { VM_ID = c.vmId; VM_NAME = c.vmName || VM_ID; VM_SOURCE = 'cache'; return; }
    } catch { /* 无缓存 -> 自动发现 */ }
  }
  // 2026-10-06 超时加固：沙箱直连可能被黑洞（无 RST、无响应），fetch 必须带超时，否则 daemon 永久挂起、保活也发现不了
  const res = await fetch('https://muse.ai/api/session', { headers: { ...BROWSER_HDR, Cookie: cookiesHeader() }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw httpError('vmId auto-discovery failed: /api/session http ' + res.status + ' (unauthorized / invalid session?)', res.status, res.status === 401 ? 'AUTH_FAILED' : undefined);
  const j = await res.json();
  const vms = Array.isArray(j.vms) ? j.vms : [];
  const pick = vms.find(v => v && v.is_preferred) || vms[0] || (j.vm_id ? { vm_id: j.vm_id, name: j.vm_name } : null);
  if (!pick || !pick.vm_id) throw new Error('vmId auto-discovery: no VM in /api/session (fallback: create data/muse-config.json with {"vmId":"..."})');
  VM_ID = pick.vm_id; VM_NAME = pick.name || pick.vm_name || VM_ID; VM_SOURCE = 'discovered'; SKIP_VM_CACHE = false;
  try { paths.writeSecret(CONFIG_PATH, JSON.stringify({ vmId: VM_ID, vmName: VM_NAME }, null, 2)); } catch {}
  console.error('vmId auto-discovered: ' + VM_ID);
}
const LB = 'hatch.metaaivm.com';
const TOKEN_RETRY_MS = Math.max(0, parseInt(process.env.MUSE_TOKEN_RETRY_MS || '1200', 10) || 0);   // token 403 重试间隔（测试可调小）

// 简易路由表（从 scripts/deps/muse-dep-2ksz.js 摘取常用项）
const ROUTES = {
  'egress.approvals': { m: 'GET', path: '/approvals', svc: 'sentinel' },
  'egress.permissions': { m: 'GET', path: '/permissions', svc: 'sentinel' },
  'egress.permissions.scoped': { m: 'GET', path: '/permissions/scopes/{scope_type}/{scope_id}', svc: 'sentinel' },
  'permissions.settings': { m: 'GET', path: '/permissions/settings', svc: 'sentinel' },
  'egress.permissions.active': { m: 'GET', path: '/permissions/active', svc: 'sentinel' },
  'egress.permissions.network_rules': { m: 'PATCH', path: '/permissions/network-rules', svc: 'sentinel' },
  'egress.approval': { m: 'GET', path: '/approvals/{approval_id}', svc: 'sentinel' },
  'egress.approval.decide': { m: 'POST', path: '/approvals/{approval_id}/decide', svc: 'sentinel' },
  'egress.approval.history': { m: 'GET', path: '/approvals/history', svc: 'sentinel' },
  'chat.history': { m: 'GET', path: '/chat/history', svc: 'daemon' },
  'sessions.list': { m: 'GET', path: '/sessions', svc: 'daemon' },
};

const BROWSER_HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5',
  'Referer': 'https://muse.ai/',
  'Origin': 'https://muse.ai',
  'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin',
  'Content-Type': 'application/json',
};

/* 读会话 cookie。文件不存在 / 无 hatch_sess -> code=NO_SESSION；文件损坏（如写到一半被杀）-> code=BAD_COOKIES。
 * 两者都会被 daemon 判定为"需要重新登录"。 */
function cookiesHeader() {
  let raw;
  try { raw = fs.readFileSync(COOKIE_PATH, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw Object.assign(new Error('invalid session: ' + COOKIE_PATH + ' 不存在 (ENOENT)'), { code: 'NO_SESSION' });
    throw e;
  }
  let list;
  try { list = JSON.parse(raw); } catch { throw Object.assign(new Error('invalid session: cookies.json corrupt'), { code: 'BAD_COOKIES' }); }
  if (!Array.isArray(list)) throw Object.assign(new Error('invalid session: cookies.json corrupt (not an array)'), { code: 'BAD_COOKIES' });
  // 只发 hatch_sess：全量 cookie（陈旧 hatch_gw 等）会让 token 端点 403
  const h = list.filter(c => c && c.name === 'hatch_sess' && c.value).map(c => `${c.name}=${c.value}`).join('; ');
  if (!h) throw Object.assign(new Error('invalid session: cookies.json 中没有 hatch_sess'), { code: 'NO_SESSION' });
  return h;
}

function rollCookiesFromToken(res) {
  try {
    const scs = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const vals = scs.map(sc => /^hatch_sess=([^;]+)/.exec(sc)).filter(Boolean).map(m => m[1]).filter(v => v && v.length > 10);
    if (!vals.length) return;
    const list = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
    let found = false;
    for (const c of list) if (c.name === 'hatch_sess') { c.value = vals[vals.length - 1]; found = true; }
    if (!found) list.push({ name: 'hatch_sess', value: vals[vals.length - 1], domain: '.muse.ai', path: '/' });
    paths.writeSecret(COOKIE_PATH, JSON.stringify(list, null, 1));   // 0600 + 原子写
    console.error('hatch_sess rotated by token endpoint -> cookies.json updated');
  } catch (e) { console.error('rollCookiesFromToken failed:', e.message); }
}

async function mintToken() {
  await discoverVmId();   // touch 路径也可能在 vmId 缓存被作废后调用
  const vmAddress = `https://${VM_ID}.metaaivm.com/`;
  // 403 retry: token 端偶发 opaquely Forbidden（瞬时），重试即可
  let res, txt;
  for (let i = 1; i <= 5; i++) {
    // 2026-10-06 超时加固：同 discoverVmId，直连黑洞时 fetch 会永久挂起
    res = await fetch('https://muse.ai/api/hatch/token', {
      method: 'POST',
      headers: { ...BROWSER_HDR, 'Cookie': cookiesHeader() },
      body: JSON.stringify({ vmAddress, vmName: VM_NAME }),
      signal: AbortSignal.timeout(15000),
    });
    txt = await res.text();
    if (res.ok) break;
    if (res.status === 403 && i < 5) { console.error(`token 403 retry ${i}/5...`); await new Promise(r => setTimeout(r, TOKEN_RETRY_MS)); continue; }
    break;
  }
  if (!res.ok) {
    // 403 重试仍失败：常见原因是 VM 换了、缓存的 vmId 过期。作废缓存，下次重新 GET /api/session 发现；
    // 会话真失效时 /api/session 会返回 401 -> AUTH_FAILED -> 由上层重登。403 本身不触发重登（避免刷验证码邮件）。
    if (res.status === 403 && VM_SOURCE !== 'env') { VM_ID = null; VM_NAME = null; VM_SOURCE = null; SKIP_VM_CACHE = true; }
    throw httpError(`token ${res.status}: ${txt.slice(0, 300)}`, res.status, res.status === 401 ? 'AUTH_FAILED' : undefined);
  }
  const j = JSON.parse(txt);
  rollCookiesFromToken(res);
  // 只记录 mint 时间（排障用）；token 本身不落盘
  try { paths.writeSecret(TOKEN_PATH, JSON.stringify({ mintedAt: Date.now() }, null, 2)); } catch {}
  return j; // {token, notary_token?, ...}
}

function buildWsUrl(token, notaryToken) {
  const q = new URLSearchParams();
  q.set('vm_id', VM_ID);
  q.set('auth_token', token);
  if (notaryToken) q.set('notary_token', notaryToken);
  q.set('app_id', APP_ID);
  q.set('request_id', crypto.randomUUID());
  return `wss://${LB}/v1/noise?${q.toString()}`;
}

/* 常驻消息分发器（L4）：握手完成后由它独占 ws.onmessage，按顺序解密每一帧（保持 recv nonce 同步），
 * 再按 streamId 分发给等待中的 rpcCall；没人等的帧（服务端主动推送）也会被解密后丢弃，而不是不解密直接丢。
 * 解密失败 = 通道失步，拒绝所有等待者并关闭 ws（上层重连）。 */
function attachDispatcher(ws, transport) {
  const conn = { ws, transport, pending: new Map(), closed: false, closeError: null };
  const failAll = (err) => {
    for (const h of conn.pending.values()) { try { h.reject(err); } catch {} }
    conn.pending.clear();
  };
  ws.onmessage = (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) return;
    let msg;
    try { msg = transport.decryptFrame(new Uint8Array(ev.data)); }
    catch (e) {
      conn.closed = true; conn.closeError = new Error('noise decrypt failed: ' + e.message);
      failAll(conn.closeError);
      try { ws.close(); } catch {}
      return;
    }
    if (!msg) return;
    const h = conn.pending.get(String(msg.streamId));
    if (h) h.onFrame(msg);
  };
  ws.onclose = () => { conn.closed = true; if (!conn.closeError) conn.closeError = new Error('ws closed'); failAll(conn.closeError); };
  ws.onerror = () => {};
  return conn;
}

/* 连接 + Noise 握手 → { ws, transport, pending, ... }
 * opts.proxy: undefined=按 MUSE_PROXY；null=强制直连；字符串=指定代理（daemon 按模式传，不再改 process.env）
 * 安全说明（L5）：这里不校验服务端 Noise 静态公钥 / SNP 证明（官方客户端会校验），
 * 机密性与服务端身份只依赖外层 wss 的 TLS 证书校验——比官方客户端的保证弱，知悉即可。 */
async function connect(opts = {}) {
  await discoverVmId();
  const cred = await mintToken();
  const url = buildWsUrl(cred.token, cred.notary_token || null);
  const ws = createWS(url, {}, opts.proxy);
  ws.binaryType = 'arraybuffer';
  let ok = false;
  try {
    // 2026-10-06 超时加固：代理 CONNECT 被挂起或直连被黑洞时 open 永远不触发，必须超时失败走重试/回退，不能永久挂起
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws open timeout (15s)')), 15000);
      const done = (fn) => (...a) => { clearTimeout(t); fn(...a); };
      ws.onopen = done(res);
      ws.onerror = done(() => rej(new Error('ws error')));
      ws.onclose = done(() => rej(new Error('ws closed before open')));
    });

    const next = () => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('handshake timeout')), 10000);
      ws.onmessage = (ev) => { clearTimeout(t); ws.onmessage = null; resolve(new Uint8Array(ev.data)); };
      ws.onclose = () => { clearTimeout(t); reject(new Error('ws closed during handshake')); };
    });

    const xx = new NoiseXXInitiator();
    xx.initialize();
    // msg1 payload = protobuf field1 bytes(32 随机 nonce)：[0x0a,0x20,nonce...]
    const nonce = crypto.randomBytes(32);
    const p1 = pbConcatFields([pbBytes(1, nonce)]);
    const m1 = xx.writeMessage1(p1);
    const m2p = next();   // 先挂 handler 再发，避免极快的 msg2 落在 handler 之前
    ws.send(m1);
    const m2 = await m2p;
    const _p2 = xx.readMessage2(m2); // 服务器证据载荷（不校验 SNP，见上方安全说明）
    // msg3: 本项目不需要 RV 挑战时 payload 为空（浏览器实测 msg3=64B）
    const m3 = xx.writeMessage3(new Uint8Array(0));
    const { send, recv } = xx.split();
    const transport = new NoiseTransport(send, recv);
    const conn = attachDispatcher(ws, transport);   // 发 msg3 之前就装好常驻分发器，不漏任何服务端帧
    ws.send(m3);
    ok = true;
    return conn;
  } finally {
    if (!ok) { try { ws.close(); } catch {} }   // 握手失败不泄漏 socket
  }
}

/* 在 conn 上发一组帧并收集某个 stream 的完整响应 -> { status, body(Buffer) } */
function requestStream(conn, streamId, frames, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    if (conn.closed || (conn.ws && conn.ws.readyState !== undefined && conn.ws.readyState !== 1)) {
      return reject(conn.closeError || new Error('ws closed'));
    }
    const key = String(streamId);
    let acc = [], status = 0, settled = false;
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); conn.pending.delete(key); fn(v); };
    const timer = setTimeout(() => settle(reject, new Error('rpc timeout for ' + label)), timeoutMs);
    conn.pending.set(key, {
      reject: (e) => settle(reject, e),
      onFrame: (msg) => {
        if (msg.type === 'response') {
          if (msg.status) status = msg.status;
          if (msg.body && msg.body.length) acc.push(Buffer.from(msg.body));
          if (msg.endBody) settle(resolve, { status, body: Buffer.concat(acc) });
        } else if (msg.type === 'bodyChunk') {
          acc.push(Buffer.from(msg.data));
          if (msg.endBody) settle(resolve, { status, body: Buffer.concat(acc) });
        } else if (msg.type === 'reset') settle(reject, new Error('stream reset'));
      },
    });
    // ws 8 在非 OPEN 状态下 send() 不带回调会静默丢帧：带回调，发送失败立刻报错而不是白等超时
    for (const f of frames) {
      try { conn.ws.send(f, (err) => { if (err) settle(reject, err); }); }
      catch (e) { settle(reject, e); break; }
    }
  });
}

/* 把网关响应解释为结果或错误（M1）：HTTP >= 400 或 {ok:false} 或带 error 字段一律视为失败，
 * 错误对象带 status / data / rejected=true（"服务端明确拒绝"，区别于超时断线）。 */
function interpretResponse(method, status, raw) {
  let parsed; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  const isObj = parsed && typeof parsed === 'object';
  if (isObj && parsed.ok === true && 'result' in parsed && !(status >= 400)) return parsed.result;
  if (isObj && parsed.error) {
    throw Object.assign(new Error('rpc error: ' + JSON.stringify(parsed.error).slice(0, 400)), { status: status || undefined, data: parsed, rejected: true });
  }
  if (status >= 400 || (isObj && parsed.ok === false)) {
    throw Object.assign(new Error(`rpc ${method} http ${status || '?'}: ${String(raw).slice(0, 300)}`), { status: status || undefined, data: isObj ? parsed : undefined, rejected: true });
  }
  return parsed;
}

// 发送 RPC 并等响应（JSON 解析 {ok, result}）
async function rpcCall(conn, method, params = {}) {
  const route = ROUTES[method];
  if (!route) throw new Error('no route for ' + method);
  if (conn.closed || (conn.ws && conn.ws.readyState !== undefined && conn.ws.readyState !== 1)) throw conn.closeError || new Error('ws closed');
  let p = route.path; const bodyParams = { ...params };
  p = p.replace(/\{([^}]+)\}/g, (_, k) => { const v = bodyParams[k]; if (v === undefined) throw new Error('missing param ' + k); delete bodyParams[k]; return encodeURIComponent(String(v)); });
  const isGet = route.m === 'GET';
  const headers = [
    { key: 'x-request-id', value: crypto.randomUUID() },
    { key: 'x-app-id', value: APP_ID },
    { key: 'Accept-Language', value: 'zh-CN' },
  ];
  const reqPath = isGet ? appendQuery(p, bodyParams) : p;
  const body = isGet ? new Uint8Array(0) : te.encode(JSON.stringify(bodyParams));
  if (!isGet) headers.unshift({ key: 'Content-Type', value: 'application/json' });
  const { streamId, frames } = await conn.transport.encryptHttpRequest({ httpMethod: route.m, path: reqPath, body, service: route.svc || 'daemon', headers });
  const { status, body: out } = await requestStream(conn, streamId, frames, 20000, method);
  return interpretResponse(method, status, out.toString('utf8'));
}

function appendQuery(p, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) { if (v === undefined || v === null) continue; q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v)); }
  const s = q.toString();
  return s ? p + '?' + s : p;
}

async function main() {
  const [cmd, a1, a2, a3, ...rest] = process.argv.slice(2);
  const conn = await connect();
  try {
    if (cmd === 'raw') {
      // 直接发自定义 {httpMethod,path,body,service,headers} — 排障用
      const spec = JSON.parse(a1);
      spec.body = spec.body ? new Uint8Array(Buffer.from(spec.body, 'base64')) : new Uint8Array(0);
      const { streamId, frames } = await conn.transport.encryptHttpRequest(spec);
      console.log('sent streamId', streamId.toString(), 'frames', frames.length);
      const { status, body: out } = await requestStream(conn, streamId, frames, 15000, 'raw');
      console.log('status', status);
      console.log(out.toString('utf8').slice(0, 4000));
      return;
    }
    if (cmd === 'list') {
      const r = await rpcCall(conn, 'egress.approvals', {});
      console.log(JSON.stringify(r, null, 2).slice(0, 6000));
      return;
    }
    if (cmd === 'detail') {
      const r = await rpcCall(conn, 'egress.approval', { approval_id: a1 });
      console.log(JSON.stringify(r, null, 2).slice(0, 6000));
      return;
    }
    if (cmd === 'history') {
      const r = await rpcCall(conn, 'egress.approval.history', a1 ? { cursor: a1 } : {});
      console.log(JSON.stringify(r, null, 2).slice(0, 6000));
      return;
    }
    if (cmd === 'decide') {
      // decide <approval_id> <decision> [reason]
      const params = { approval_id: a1, decision: a2 };
      if (a3) params.reason = a3;
      const r = await rpcCall(conn, 'egress.approval.decide', params);
      console.log(JSON.stringify(r, null, 2).slice(0, 6000));
      return;
    }
    if (cmd === 'call') {
      const r = await rpcCall(conn, a1, JSON.parse(a2 || '{}'));
      console.log(JSON.stringify(r, null, 2).slice(0, 6000));
      return;
    }
    console.log('usage: list | detail <id> | history [cursor] | decide <id> <decision> [reason] | call <method> <json> | raw <json>');
  } finally {
    try { conn.ws.close(); } catch {}
  }
}

if (require.main === module) { main().catch(e => { console.error('ERR:', e.message); process.exit(1); }); }
module.exports = { connect, rpcCall, ROUTES, mintToken, cookiesHeader, attachDispatcher, interpretResponse, COOKIE_PATH, DATA_DIR: paths.DATA_DIR, LOG_DIR: paths.LOG_DIR };