'use strict';
const { TMP, blockNetwork } = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');

const daemon = require('../muse-daemon.cjs');
const aa = require('../work/auto-approve.cjs');
const { shouldFallback, buildDecideParams } = require('../work/decision.cjs');
blockNetwork();

const ROOT = path.resolve(__dirname, '..');

test('parseArgs: 默认仍是 allow_always + destination_domain + fallback（H1 不变）', () => {
  const o = daemon.parseArgs([]);
  assert.equal(o.decision, 'allow_always');
  assert.equal(o.scope, 'destination_domain');
  assert.equal(o.fallbackOnce, true);
  assert.equal(o.mode, 'loop');
  assert.equal(o.interval, 10000);
  assert.deepEqual(buildDecideParams('A1', o), { approval_id: 'A1', decision: 'allow_always', always_scope: 'destination_domain', allow_always_scope: 'destination_domain' });
});

test('parseArgs: 决策值白名单（拼错 / 缺值都报 BAD_ARGS）', () => {
  for (const p of [daemon.parseArgs, aa.parseArgs]) {
    assert.throws(() => p(['--decision', 'deny_alway']), { code: 'BAD_ARGS' });
    assert.throws(() => p(['--decision']), { code: 'BAD_ARGS' });
    assert.throws(() => p(['--decision', '--dry']), { code: 'BAD_ARGS' });
    assert.throws(() => p(['--scope']), { code: 'BAD_ARGS' });
    for (const d of ['allow_once', 'allow_session', 'allow_always', 'deny_once', 'deny_always']) assert.equal(p(['--decision', d]).decision, d);
  }
  assert.deepEqual(buildDecideParams('X', daemon.parseArgs(['--decision', 'deny_always'])),
    { approval_id: 'X', decision: 'deny_always', always_scope: 'destination_domain' });
});

test('CLI: 非法 --decision 退出码 2，且不出网', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'muse-daemon.cjs'), '--once', '--decision', 'deny_alway'], { env: process.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /非法 --decision/);
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'work/auto-approve.cjs'), '--once', '--decision'], { env: process.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(r2.status, 2, r2.stderr);
});

test('shouldFallback: deny 永不回退；只在服务端明确拒绝时回退；超时不回退', () => {
  const rejected = Object.assign(new Error('rpc x http 409'), { status: 409, rejected: true });
  const timeout = new Error('rpc timeout for egress.approval.decide');
  assert.equal(shouldFallback({ fallbackOnce: true, decision: 'allow_always' }, rejected), true);
  assert.equal(shouldFallback({ fallbackOnce: true, decision: 'allow_session' }, rejected), true);
  assert.equal(shouldFallback({ fallbackOnce: true, decision: 'allow_always' }, timeout), false);
  assert.equal(shouldFallback({ fallbackOnce: true, decision: 'allow_once' }, rejected), false);
  assert.equal(shouldFallback({ fallbackOnce: true, decision: 'deny_always' }, rejected), false);
  assert.equal(shouldFallback({ fallbackOnce: true, decision: 'deny_once' }, rejected), false);
  assert.equal(shouldFallback({ fallbackOnce: false, decision: 'allow_always' }, rejected), false);
});

function mockRpc(script) {
  const calls = [];
  return {
    calls,
    rpcCall: async (conn, method, params) => {
      calls.push([method, params]);
      const r = script(method, params, calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const LIST = { pending: [{ approval_id: 'A1' }], pending_approvals: [{ approval_id: 'A1' }, { approval_id: 'A2' }] };
const rejectErr = () => Object.assign(new Error('rpc decide http 400: bad'), { status: 400, rejected: true });

for (const [name, sweepFn] of [['daemon', (c, o, r) => daemon.sweep(c, o, r)], ['auto-approve', (c, o, r) => aa.sweep(c, o, r)]]) {
  test(`${name}.sweep: deny_always 失败后绝不发 allow_*（H2 复现用例）`, async () => {
    const rpc = mockRpc((m) => m === 'egress.approvals' ? LIST : rejectErr());
    const n = await sweepFn({}, { decision: 'deny_always', scope: 'destination_domain', fallbackOnce: true }, rpc);
    assert.equal(n, 0);
    const decides = rpc.calls.filter(c => c[0] === 'egress.approval.decide');
    assert.equal(decides.length, 2);   // A1、A2 各一次（同 id 去重）
    for (const [, p] of decides) assert.equal(p.decision, 'deny_always');
  });

  test(`${name}.sweep: allow_always 被拒 -> 回退 allow_once；超时不回退`, async () => {
    let rpc = mockRpc((m, p) => m === 'egress.approvals' ? LIST : (p.decision === 'allow_always' ? rejectErr() : { approval: { status: 'approved' } }));
    let n = await sweepFn({}, { decision: 'allow_always', scope: 'destination_domain', fallbackOnce: true }, rpc);
    assert.equal(n, 2);
    assert.deepEqual(rpc.calls.filter(c => c[0] === 'egress.approval.decide').map(c => c[1].decision), ['allow_always', 'allow_once', 'allow_always', 'allow_once']);

    rpc = mockRpc((m) => m === 'egress.approvals' ? LIST : new Error('rpc timeout for egress.approval.decide'));
    n = await sweepFn({}, { decision: 'allow_always', scope: 'destination_domain', fallbackOnce: true }, rpc);
    assert.equal(n, 0);
    assert.deepEqual(rpc.calls.filter(c => c[0] === 'egress.approval.decide').map(c => c[1].decision), ['allow_always', 'allow_always']);
  });

  test(`${name}.sweep: 列表失败要 throw（交给重连）`, async () => {
    const rpc = mockRpc(() => new Error('ws closed'));
    await assert.rejects(sweepFn({}, { decision: 'allow_always', fallbackOnce: true }, rpc), /ws closed/);
  });
}

test('reconnectDelay 指数退避封顶 5 分钟', () => {
  assert.equal(daemon.reconnectDelay(1), 5000);
  assert.equal(daemon.reconnectDelay(2), 10000);
  assert.equal(daemon.reconnectDelay(20), 300000);
});

test('isDaemonPid: 非 muse-daemon 进程（PID 复用）不算', () => {
  assert.equal(daemon.isDaemonPid(process.pid), false);   // 测试进程的 cmdline 里没有 muse-daemon
  assert.equal(daemon.isDaemonPid(2 ** 22 + 12345), false);
});

void TMP;
