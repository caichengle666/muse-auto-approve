'use strict';
/*
 * 审批决策的共享逻辑（muse-daemon.cjs 与 work/auto-approve.cjs 共用）
 *
 * - DECISIONS：合法决策值白名单；--decision 拼错 / 缺值直接报错（退出码 2），绝不带着 undefined 去调接口
 * - buildDecideParams：发送形状复刻前端 eJ：{ approval_id, decision, always_scope: S, allow_always_scope: S }
 *     always_scope 在 allow_always / deny_always 时都带；allow_always_scope 仅 allow_always 额外带
 * - shouldFallback：回退只在 allow 类决策之间进行（allow_always / allow_session 失败 -> allow_once），
 *     deny_* 永远不会回退成 allow；并且只有服务端"明确拒绝"（HTTP 4xx/5xx、{ok:false}、rpc error）才回退，
 *     超时 / 断线这类"不知道生效没有"的失败不回退（下一轮若仍 pending 会再按原决策处理）。
 */
const DECISIONS = new Set(['allow_once', 'allow_session', 'allow_always', 'deny_once', 'deny_always']);

function badArgs(msg) { const e = new Error(msg); e.code = 'BAD_ARGS'; return e; }

/* 读取 flag 的取值：缺值或下一个是另一个 flag 时报错 */
function takeValue(argv, i, flag) {
  const v = argv[i + 1];
  if (v === undefined || v === '' || v.startsWith('--')) throw badArgs(flag + ' 缺少取值');
  return v;
}

function validateDecision(decision) {
  if (!DECISIONS.has(decision)) {
    throw badArgs('非法 --decision: ' + JSON.stringify(decision) + '（可选: ' + [...DECISIONS].join(' / ') + '）');
  }
  return decision;
}

function buildDecideParams(id, opts) {
  const p = { approval_id: id, decision: opts.decision };
  if ((opts.decision === 'allow_always' || opts.decision === 'deny_always') && opts.scope) {
    p.always_scope = opts.scope;
    if (opts.decision === 'allow_always') p.allow_always_scope = opts.scope;
  }
  return p;
}

/* 服务端明确拒绝了这次请求（区别于超时 / 断线这类结果未知的失败） */
function isServerRejection(e) {
  return !!(e && (e.rejected === true || (typeof e.status === 'number' && e.status >= 400)));
}

function shouldFallback(opts, err) {
  if (!opts || !opts.fallbackOnce) return false;
  const d = opts.decision;
  if (d !== 'allow_always' && d !== 'allow_session') return false;   // 只在 allow 类之间回退；deny_* 永不回退
  return isServerRejection(err);
}

module.exports = { DECISIONS, badArgs, takeValue, validateDecision, buildDecideParams, isServerRejection, shouldFallback };
