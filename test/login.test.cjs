'use strict';
const { TMP, blockNetwork, fakeResponse } = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const paths = require('../work/paths.cjs');
const { needsLogin, createLoginGuard } = require('../work/login-guard.cjs');
const loginLib = require('../work/login-lib.cjs');
blockNetwork();

const credsOk = () => ({ email: 'a@b.c', password: 'x', source: 'env' });

function guard(t0, loginFn, extra = {}) {
  let now = t0;
  const sp = path.join(TMP, 'state-' + Math.random().toString(36).slice(2) + '.json');
  const bp = sp + '.blocked';
  const g = createLoginGuard({ login: loginFn, resolveCredentials: credsOk, now: () => now, statePath: sp, blockPath: bp, baseGapMs: 1000, maxGapMs: 8000, maxFails: 5, ...extra });
  return { g, sp, bp, advance: (ms) => { now += ms; }, mk: () => createLoginGuard({ login: loginFn, resolveCredentials: credsOk, now: () => now, statePath: sp, blockPath: bp, baseGapMs: 1000, maxGapMs: 8000, maxFails: 5, ...extra }) };
}

test('needsLogin 只认确定的认证失败（token 403 / forbidden 不重登）', () => {
  assert.equal(needsLogin(new Error('token 403: Forbidden')), false);
  assert.equal(needsLogin(new Error('Forbidden by upstream')), false);
  assert.equal(needsLogin(new Error('unauthorized-ish proxy message')), false);
  assert.equal(needsLogin(new Error('fetch failed')), false);
  assert.equal(needsLogin(Object.assign(new Error('ENOENT: open /x/other.json'), { code: 'ENOENT' })), false);
  assert.equal(needsLogin(new Error('token 401: nope')), true);
  assert.equal(needsLogin(Object.assign(new Error('x'), { code: 'NO_SESSION' })), true);
  assert.equal(needsLogin(Object.assign(new Error('x'), { code: 'BAD_COOKIES' })), true);
  assert.equal(needsLogin(Object.assign(new Error('x'), { code: 'AUTH_FAILED' })), true);
});

test('登录节流 + 指数退避 + 熔断', async () => {
  let calls = 0;
  const { g, bp, advance, mk } = guard(1_000_000, async () => { calls++; throw new Error('confirm-password 401'); });
  await assert.rejects(g.login(), /confirm-password/);           // 第 1 次：立即允许
  assert.equal(calls, 1);
  await assert.rejects(g.login(), { code: 'LOGIN_THROTTLED' });  // 节流窗口内不发
  assert.equal(calls, 1);
  advance(1500);                                                 // 失败 1 次 -> gap 2000
  await assert.rejects(g.login(), { code: 'LOGIN_THROTTLED' });
  await assert.rejects(mk().login(), { code: 'LOGIN_THROTTLED' }); // 新进程（新实例）读到同一状态，也被节流
  advance(600);
  await assert.rejects(g.login(), /confirm-password/);
  assert.equal(calls, 2);
  assert.equal(g.gapFor(2), 4000);
  assert.equal(g.gapFor(10), 8000);                              // 封顶
  for (let i = 0; i < 3; i++) { advance(10_000); await g.login().catch(() => {}); }
  assert.equal(calls, 5);
  assert.ok(fs.existsSync(bp), '连续 5 次失败应写熔断文件');
  advance(10 ** 9);
  await assert.rejects(g.login(), { code: 'LOGIN_GIVEUP' });     // 熔断后不再尝试
  assert.equal(calls, 5);
  g.reset();
  assert.ok(!fs.existsSync(bp));
});

test('第 5 次失败本身抛 LOGIN_GIVEUP；成功会清零失败计数', async () => {
  let fail = true, calls = 0;
  const { g, advance } = guard(5_000_000, async () => { calls++; if (fail) throw new Error('boom'); return { ok: 1 }; });
  for (let i = 0; i < 3; i++) { await g.login().catch(() => {}); advance(100_000); }
  fail = false;
  assert.deepEqual(await g.login(), { ok: 1 });
  assert.equal(g.readState().fails, 0);
  fail = true;
  advance(100_000);
  for (let i = 0; i < 4; i++) { await g.login().catch(() => {}); advance(100_000); }
  await assert.rejects(g.login(), { code: 'LOGIN_GIVEUP' });
  assert.equal(calls, 9);
});

test('凭据缺失 / 混用不计数、不占节流窗口、不调用 login', async () => {
  let calls = 0;
  const { g } = guard(1, async () => { calls++; }, { resolveCredentials: () => { throw Object.assign(new Error('no'), { code: 'NO_CREDENTIALS' }); } });
  await assert.rejects(g.login(), { code: 'NO_CREDENTIALS' });
  await assert.rejects(g.login(), { code: 'NO_CREDENTIALS' });
  assert.equal(calls, 0);
  assert.equal(g.readState().fails, 0);
});

test('resolveCredentials：邮箱/密码来源混用直接报 MIXED_CREDENTIALS（L6）', () => {
  fs.writeFileSync(paths.CRED_PATH, JSON.stringify({ email: 'file@x', password: 'pf' }));
  try {
    assert.equal(loginLib.resolveCredentials({}).source, 'file');
    process.env.MUSE_USER = 'env@x';
    assert.throws(() => loginLib.resolveCredentials({}), { code: 'MIXED_CREDENTIALS' });
    process.env.MUSE_PASSWORD = 'pe';
    assert.deepEqual(loginLib.resolveCredentials({}), { email: 'env@x', password: 'pe', source: 'env' });
    delete process.env.MUSE_USER;
    assert.throws(() => loginLib.resolveCredentials({}), { code: 'MIXED_CREDENTIALS' });
  } finally {
    delete process.env.MUSE_USER; delete process.env.MUSE_PASSWORD;
    fs.unlinkSync(paths.CRED_PATH);
  }
  assert.throws(() => loginLib.resolveCredentials({}), { code: 'NO_CREDENTIALS' });
  process.env.MUSE_USER = 'only@x';
  try { assert.throws(() => loginLib.resolveCredentials({}), { code: 'NO_CREDENTIALS' }); }
  finally { delete process.env.MUSE_USER; }
});

test('login(): 每个请求都带超时 signal（M8），失败即抛', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(init && init.signal); return fakeResponse(500, 'down'); };
  try {
    await assert.rejects(loginLib.login({ email: 'a@b.c', password: 'x' }), /restart 500/);
  } finally { blockNetwork(); }
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof AbortSignal);
});

test('login(): 成功后 cookies.json 0600、备份只留 2 份、日志不含会话前缀（M3/L3）', async () => {
  const sess = 'SESSIONVALUE-' + 'z'.repeat(60);
  fs.writeFileSync(paths.COOKIE_PATH, JSON.stringify([{ name: 'hatch_sess', value: 'old-session-value-xxxxxxxx' }]));
  for (const ts of [1, 2, 3]) fs.writeFileSync(paths.COOKIE_PATH + '.bak.' + ts, '[]');
  const sodium = require('sodium-native');
  const pk = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES), sk = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
  sodium.crypto_box_keypair(pk, sk);
  globalThis.fetch = async (url) => {
    if (url.endsWith('/restart')) return fakeResponse(201, { csrf_token: 'c', password_encryption: { key_id: 7, public_key: pk.toString('base64') } });
    if (url.endsWith('/send-otp')) return fakeResponse(200, { ok: true });
    if (url.endsWith('/confirm-password')) return fakeResponse(200, { redirect_to: '/' }, { 'set-cookie': ['hatch_sess=' + sess + '; Path=/; HttpOnly'] });
    throw new Error('unexpected ' + url);
  };
  const logs = [];
  try { await loginLib.login({ email: 'a@b.c', password: 'pw', log: (m) => logs.push(m) }); }
  finally { blockNetwork(); }
  assert.equal(fs.statSync(paths.COOKIE_PATH).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(paths.COOKIE_PATH, 'utf8'))[0].value, sess);
  const baks = fs.readdirSync(paths.DATA_DIR).filter(n => n.startsWith('cookies.json.bak.'));
  assert.equal(baks.length, 2);
  assert.ok(baks.includes('cookies.json.bak.3') && !baks.includes('cookies.json.bak.1'), '应删掉最旧的备份');
  const fresh = baks.find(b => !b.endsWith('.bak.3'));
  assert.equal(fs.statSync(path.join(paths.DATA_DIR, fresh)).mode & 0o777, 0o600, '新备份应为 0600');
  assert.ok(!logs.join('\n').includes('SESSIONVALUE'));
  assert.ok(!fs.readdirSync(paths.DATA_DIR).some(n => n.includes('.tmp')), '不应残留临时文件');
});
