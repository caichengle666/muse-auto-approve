'use strict';
/*
 * muse.ai 审批自动批准器 v2 (auto-approve)
 * 依赖: muse-rpc.cjs（已模块化导出 connect/rpcCall）
 *
 * 注意：这是 muse-daemon.cjs 的精简前身，**不做 token touch、不自动登录**，--loop 长跑约 30 天后会话会失效；
 * 长期挂机请用 muse-daemon.cjs。--loop 掉线后会自动重连。
 *
 * 用法:
 *   node work/auto-approve.cjs --once                      # 拉一次 pending，逐条 allow_once
 *   node work/auto-approve.cjs --once --always             # 永久模式: allow_always + scope=destination_domain
 *   node work/auto-approve.cjs --loop 10000 --always       # 永久模式持续挂机
 *   node work/auto-approve.cjs --once --always --fallback-once   # allow_always 失败时回退 allow_once
 *   node work/auto-approve.cjs --once --decision allow_session
 *   node work/auto-approve.cjs --once --dry                # 只看不批（演练）
 *
 * decision 说明:
 *   allow_once    仅本次(默认)
 *   allow_session 本任务期间(UI: Allow for this task)
 *   allow_always  永久允许(UI: Always allow) —— 必须带 scope:
 *                   - 普通网络审批: destination_domain (UI: Always allow this site)
 *                   - deny_always 同样带 scope
 *   发送形状(复刻前端 eJ): { approval_id, decision, always_scope: S, allow_always_scope: S }
 *     - always_scope 在 allow_always/deny_always 时都带
 *     - allow_always_scope 仅 allow_always 额外带
 *   --decision 只接受 allow_once / allow_session / allow_always / deny_once / deny_always，拼错或缺值退出码 2
 *   --fallback-once 只在 allow 类之间回退（allow_always / allow_session 被服务端明确拒绝 -> allow_once），deny_* 永不回退
 *
 * 日志: log/auto-approve-log.ndjson（每条一行 JSON: decided / error / heartbeat）
 * 退出: --once 模式处理完即退出；--loop 模式 Ctrl+C 或写 data/auto-approve.stop 文件停止
 */
const fs = require('fs');
const paths = require('./paths.cjs');
const { connect, rpcCall } = require('./muse-rpc.cjs');
const { takeValue, validateDecision, buildDecideParams, shouldFallback } = require('./decision.cjs');

const LOG = paths.AUTO_APPROVE_LOG_PATH;
const STOP = paths.AUTO_APPROVE_STOP_PATH;

function log(obj) {
  const line = JSON.stringify({ ts: Date.now(), ...obj });
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

function parseArgs(argv) {
  const a = { mode: 'once', interval: 10000, decision: 'allow_once', scope: null, fallbackOnce: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--once') a.mode = 'once';
    else if (v === '--loop') { a.mode = 'loop'; if (argv[i + 1] && /^\d+$/.test(argv[i + 1])) a.interval = parseInt(argv[++i], 10); }
    else if (v === '--decision') a.decision = takeValue(argv, i++, '--decision');
    else if (v === '--always') { a.decision = 'allow_always'; if (!a.scope) a.scope = 'destination_domain'; }
    else if (v === '--scope') a.scope = takeValue(argv, i++, '--scope');
    else if (v === '--fallback-once') a.fallbackOnce = true;
    else if (v === '--dry') a.dry = true;
  }
  validateDecision(a.decision);
  if ((a.decision === 'allow_always' || a.decision === 'deny_always') && a.scope == null) a.scope = 'destination_domain';
  return a;
}

async function sweep(conn, opts, rpc = { rpcCall }) {
  let list;
  try {
    list = await rpc.rpcCall(conn, 'egress.approvals', {});
  } catch (e) {
    log({ event: 'list_error', error: e.message });
    throw e;   // 交给 --loop 的重连分支（以前吞掉后返回 0，掉线后永远不会重连）
  }
  const pending = (list && list.pending) || [];
  const pa = (list && list.pending_approvals) || [];
  const ids = new Set([...pending.map(p => p.approval_id), ...pa.map(p => p.approval_id)].filter(Boolean));
  if (ids.size === 0) { log({ event: 'heartbeat', pending: 0 }); return 0; }

  log({ event: 'pending_found', count: ids.size, ids: [...ids] });
  let done = 0;
  for (const id of ids) {
    if (opts.dry) { log({ event: 'dry_skip', approval_id: id, would_decide: opts.decision, scope: opts.scope }); continue; }
    try {
      const r = await rpc.rpcCall(conn, 'egress.approval.decide', buildDecideParams(id, opts));
      const a = (r && r.approval) || {};
      log({
        event: 'decided', approval_id: id, decision: opts.decision, scope: opts.scope,
        status: a.status, wire_decision: a.decision, wire_scope: a.always_scope || a.allow_always_scope,
        applied_rules: Array.isArray(a.applied_rule_entries) ? a.applied_rule_entries.length : null,
        decided_at_ms: a.decided_at_ms
      });
      done++;
    } catch (e) {
      log({ event: 'decide_error', approval_id: id, decision: opts.decision, scope: opts.scope, error: e.message, status: e.status || null, data: e.data ? JSON.stringify(e.data).slice(0, 300) : undefined });
      if (shouldFallback(opts, e)) {
        try {
          const r2 = await rpc.rpcCall(conn, 'egress.approval.decide', { approval_id: id, decision: 'allow_once' });
          const a2 = (r2 && r2.approval) || {};
          log({ event: 'decided_fallback', approval_id: id, decision: 'allow_once', status: a2.status, decided_at_ms: a2.decided_at_ms });
          done++;
        } catch (e2) {
          log({ event: 'fallback_error', approval_id: id, error: e2.message });
        }
      }
    }
  }
  return done;
}

async function connectRetry(maxTries = 4, gapMs = 1500) {
  let lastErr = null;
  for (let i = 1; i <= maxTries; i++) {
    try { return await connect(); }
    catch (e) { lastErr = e; log({ event: 'connect_retry', attempt: i, error: e.message }); await new Promise(r => setTimeout(r, gapMs)); }
  }
  throw lastErr;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { if (e.code === 'BAD_ARGS') { console.error(e.message); process.exit(2); } throw e; }
  log({ event: 'start', mode: opts.mode, interval: opts.interval, decision: opts.decision, scope: opts.scope, fallbackOnce: opts.fallbackOnce, dry: opts.dry });
  const conn = await connectRetry(20, 2000);
  log({ event: 'connected' });

  if (opts.mode === 'once') {
    let n = 0;
    try { n = await sweep(conn, opts); } catch { /* list_error 已记日志 */ }
    log({ event: 'once_done', decided: n });
    try { conn.ws.close(); } catch {}
    process.exit(0);
  }

  // loop 模式：连接断开自动重连
  let curConn = conn;
  let stopped = false;
  process.on('SIGINT', () => { stopped = true; log({ event: 'sigint' }); try { curConn && curConn.ws.close(); } catch {} process.exit(0); });

  while (!stopped) {
    if (fs.existsSync(STOP)) { log({ event: 'stop_file' }); break; }
    try {
      if (!curConn) throw new Error('not connected');
      await sweep(curConn, opts);
    } catch (e) {
      log({ event: 'sweep_error', error: e.message });
      try { curConn && curConn.ws.close(); } catch {}
      await new Promise(r => setTimeout(r, 1500));
      try { curConn = await connectRetry(10, 2000); log({ event: 'reconnected' }); }
      catch (e2) { curConn = null; log({ event: 'reconnect_error', error: e2.message }); }
    }
    await new Promise(r => setTimeout(r, opts.interval));
  }
  try { curConn && curConn.ws.close(); } catch {}
  process.exit(0);
}

if (require.main === module) {
  main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
}

module.exports = { main, sweep, parseArgs, connectRetry, buildDecideParams };