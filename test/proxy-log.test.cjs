'use strict';
const { TMP, blockNetwork } = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const undici = require('undici');

const proxy = require('../work/proxy.cjs');
const daemon = require('../muse-daemon.cjs');
blockNetwork();

test('installProxy: 代理 -> 直连能真正切回直连；同地址复用；切换时 close 旧 dispatcher（M2）', async () => {
  proxy.installProxy('http://127.0.0.1:9');
  const a = proxy.currentDispatcherInfo().dispatcher;
  assert.ok(a instanceof undici.ProxyAgent);
  assert.ok(undici.getGlobalDispatcher() === a);
  proxy.installProxy('http://127.0.0.1:9');
  assert.ok(proxy.currentDispatcherInfo().dispatcher === a, '同一代理地址不应新建 ProxyAgent');
  let closed = false;
  const origClose = a.close.bind(a);
  a.close = () => { closed = true; return origClose(); };
  proxy.installProxy(null);
  const b = proxy.currentDispatcherInfo().dispatcher;
  assert.ok(!(b instanceof undici.ProxyAgent), 'direct 模式下应是普通 Agent');
  assert.ok(undici.getGlobalDispatcher() === b);
  assert.ok(closed, '旧 ProxyAgent 应被 close');
  assert.equal(process.env.MUSE_PROXY, undefined, '不应改写环境变量');
});

test('proxyFor / createWS 按模式传参，不读写 process.env', () => {
  assert.equal(daemon.proxyFor('direct', 'http://hatch-egress-proxy:1'), null);
  assert.equal(daemon.proxyFor('proxy', 'http://hatch-egress-proxy:1'), 'http://hatch-egress-proxy:1');
  process.env.MUSE_PROXY = 'http://127.0.0.1:9';
  try {
    const ws = proxy.createWS('ws://127.0.0.1:9/x', {}, null);   // 强制直连：不挂代理 agent
    ws.on('error', () => {});
    ws.terminate();
    assert.equal(process.env.MUSE_PROXY, 'http://127.0.0.1:9');
  } finally { delete process.env.MUSE_PROXY; }
});

test('trimLog: 只保留末尾整行、≤ 上限；rename 版与原地版都可用（M4）', () => {
  const f = path.join(TMP, 'big.ndjson');
  const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(40) }));
  for (const inPlace of [false, true]) {
    fs.writeFileSync(f, lines.join('\n') + '\n');
    assert.equal(daemon.trimLog(f, 1000, inPlace), true);
    const out = fs.readFileSync(f, 'utf8');
    assert.ok(Buffer.byteLength(out) <= 1000);
    const kept = out.split('\n').filter(Boolean);
    assert.ok(kept.length > 0);
    assert.equal(JSON.parse(kept[kept.length - 1]).i, 199);
    for (const l of kept) JSON.parse(l);
    assert.equal(daemon.trimLog(f, 1000, inPlace), false);
  }
  assert.ok(!fs.readdirSync(TMP).some(n => n.includes('.trim')));
});
