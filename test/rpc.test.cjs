'use strict';
const { blockNetwork, fakeResponse } = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const paths = require('../work/paths.cjs');
const rpc = require('../work/muse-rpc.cjs');
const { needsLogin } = require('../work/login-guard.cjs');
blockNetwork();

/* 假 ws + 假 transport：帧就是 JSON 字节，便于构造各种服务端响应 */
function fakeConn() {
  const sent = [];
  const ws = { readyState: 1, onmessage: null, onclose: null, onerror: null,
    send(f, cb) { if (this.readyState !== 1) { cb && cb(new Error('not open')); return; } sent.push(f); cb && cb(); },
    close() { this.readyState = 3; this.onclose && this.onclose(); } };
  let sid = 1n, decrypted = 0;
  const transport = {
    async encryptHttpRequest() { const s = sid++; return { streamId: s, frames: [Buffer.from('req' + s)] }; },
    decryptFrame(u8) { decrypted++; const m = JSON.parse(Buffer.from(u8).toString()); if (m.bad) throw new Error('bad tag'); return m; },
  };
  const conn = rpc.attachDispatcher(ws, transport);
  const push = (m) => { const b = Buffer.from(JSON.stringify(m)); ws.onmessage({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }); };
  return { conn, ws, sent, push, decrypted: () => decrypted };
}
const respond = (push, sid, status, body) => push({ streamId: String(sid), type: 'response', status, body: [...Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))], endBody: true });

test('rpcCall: HTTP 4xx/5xx 与 {ok:false} 一律 reject 并带 status/rejected（M1）', async () => {
  const f = fakeConn();
  let p = rpc.rpcCall(f.conn, 'egress.approvals', {});
  await new Promise(r => setImmediate(r));
  respond(f.push, 1, 403, { ok: false, message: 'not allowed' });
  await assert.rejects(p, (e) => e.status === 403 && e.rejected === true);

  p = rpc.rpcCall(f.conn, 'egress.approvals', {});
  await new Promise(r => setImmediate(r));
  respond(f.push, 2, 500, 'boom');
  await assert.rejects(p, (e) => e.status === 500 && /boom/.test(e.message));

  p = rpc.rpcCall(f.conn, 'egress.approvals', {});
  await new Promise(r => setImmediate(r));
  respond(f.push, 3, 200, { ok: false });
  await assert.rejects(p, (e) => e.rejected === true);

  p = rpc.rpcCall(f.conn, 'egress.approval.decide', { approval_id: 'A1', decision: 'allow_once' });
  await new Promise(r => setImmediate(r));
  respond(f.push, 4, 200, { ok: true, result: { approval: { status: 'approved' } } });
  assert.deepEqual(await p, { approval: { status: 'approved' } });
});

test('常驻分发器：无人等待的服务端帧也会被解密（nonce 不失步，L4）；解密失败关闭连接', async () => {
  const f = fakeConn();
  f.push({ streamId: '99', type: 'response', status: 200, body: [], endBody: true });   // 主动推送
  assert.equal(f.decrypted(), 1);
  const p = rpc.rpcCall(f.conn, 'egress.approvals', {});
  await new Promise(r => setImmediate(r));
  f.push({ bad: true });
  await assert.rejects(p, /noise decrypt failed/);
  assert.equal(f.ws.readyState, 3);
  await assert.rejects(rpc.rpcCall(f.conn, 'egress.approvals', {}), /noise decrypt failed|ws closed/);
});

test('ws 已关闭时 rpcCall 立刻失败而不是白等 20s（M8）', async () => {
  const f = fakeConn();
  const p = rpc.rpcCall(f.conn, 'egress.approvals', {});
  await new Promise(r => setImmediate(r));
  f.ws.close();                                   // 等待中的请求被立即拒绝
  await assert.rejects(p, /ws closed/);
  const t0 = Date.now();
  await assert.rejects(rpc.rpcCall(f.conn, 'egress.approvals', {}), /ws closed/);
  assert.ok(Date.now() - t0 < 1000);
  const g = fakeConn(); g.ws.readyState = 2;      // CLOSING
  await assert.rejects(rpc.rpcCall(g.conn, 'egress.approvals', {}), /ws closed/);
});

test('cookiesHeader：缺失 -> NO_SESSION，损坏 -> BAD_COOKIES，都会触发重登（M5）', () => {
  try { fs.unlinkSync(paths.COOKIE_PATH); } catch {}
  assert.throws(() => rpc.cookiesHeader(), (e) => e.code === 'NO_SESSION' && needsLogin(e));
  fs.writeFileSync(paths.COOKIE_PATH, '[{"name":"hatch_sess","val');
  assert.throws(() => rpc.cookiesHeader(), (e) => e.code === 'BAD_COOKIES' && needsLogin(e));
  fs.writeFileSync(paths.COOKIE_PATH, '[{"name":"other","value":"1"}]');
  assert.throws(() => rpc.cookiesHeader(), (e) => e.code === 'NO_SESSION');
  fs.writeFileSync(paths.COOKIE_PATH, '[{"name":"hatch_sess","value":"abcdefghijklmnop"},{"name":"hatch_gw","value":"x"}]');
  assert.equal(rpc.cookiesHeader(), 'hatch_sess=abcdefghijklmnop');
});

test('mintToken：401 -> AUTH_FAILED；403 不重登但作废 vmId 缓存并重新发现；token 不落盘、cookie 0600', async () => {
  fs.writeFileSync(paths.COOKIE_PATH, '[{"name":"hatch_sess","value":"abcdefghijklmnop"}]');
  fs.writeFileSync(paths.VM_CONFIG_PATH, JSON.stringify({ vmId: 'oldvm', vmName: 'old' }));
  const urls = [];
  let mode = '403';
  globalThis.fetch = async (url, init) => {
    urls.push(url);
    assert.ok(init.signal instanceof AbortSignal);
    if (url.endsWith('/api/session')) return fakeResponse(200, { vms: [{ vm_id: 'newvm', name: 'new', is_preferred: true }] });
    if (url.endsWith('/api/hatch/token')) {
      if (mode === '403') return fakeResponse(403, 'Forbidden');
      if (mode === '401') return fakeResponse(401, 'nope');
      return fakeResponse(200, { token: 'SECRET-TOKEN', notary_token: 'N' }, { 'set-cookie': ['hatch_sess=rotatedsessionvalue123; Path=/'] });
    }
    throw new Error('unexpected ' + url);
  };
  try {
    await assert.rejects(rpc.mintToken(), (e) => e.status === 403 && !needsLogin(e));
    assert.equal(urls.filter(u => u.endsWith('/api/hatch/token')).length, 5);   // 403 仍重试 5 次
    assert.ok(!urls.some(u => u.endsWith('/api/session')));                   // 首次用的是缓存 vmId
    mode = 'ok';
    const j = await rpc.mintToken();
    assert.equal(j.token, 'SECRET-TOKEN');
    assert.ok(urls.some(u => u.endsWith('/api/session')), '403 后应重新发现 vmId');
    assert.equal(JSON.parse(fs.readFileSync(paths.VM_CONFIG_PATH, 'utf8')).vmId, 'newvm');
    const tl = fs.readFileSync(paths.TOKEN_PATH, 'utf8');
    assert.ok(!tl.includes('SECRET-TOKEN'));
    assert.equal(fs.statSync(paths.TOKEN_PATH).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.COOKIE_PATH).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(paths.COOKIE_PATH, 'utf8'), /rotatedsessionvalue123/);
    mode = '401';
    await assert.rejects(rpc.mintToken(), (e) => e.code === 'AUTH_FAILED' && needsLogin(e));
  } finally { blockNetwork(); }
});
