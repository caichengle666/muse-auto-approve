'use strict';
/*
 * 统一代理层：所有出网的代理配置集中在这里
 * - 未设置 MUSE_PROXY      -> 直连（适合无需代理的网络环境）
 * - 设置 MUSE_PROXY=<url>  -> 所有出网走该代理（如本机 http://127.0.0.1:7890）
 * installProxy(): 把 npm undici 的 fetch 装成 globalThis.fetch
 *   （Node 22 全局 fetch 用的是内置 undici，npm undici 的 setGlobalDispatcher 管不到它，必须整体替换）
 *   设置代理时装 ProxyAgent；直连时装普通 Agent（即使之前装过代理也会切回直连）。
 * createWS(url): 返回 ws 包的 WebSocket（DOM 风格 onmessage/binaryType，兼容既有代码）
 *   设置代理时经 https-proxy-agent 走代理，直连时不传 agent。
 *
 * 平台适配说明（2026-10-06）：本沙箱的出口代理凭据数分钟轮换一次，
 * 因此代理地址不在模块加载时缓存，而是在每次 installProxy()/createWS() 调用时
 * 重新从环境变量读取。代理稳定时行为与原来完全一致。
 */
function normalizeProxy(raw) {
  raw = (raw || '').trim();
  if (!raw) return null;   // null 表示直连
  // 允许省略协议头（MUSE_PROXY=127.0.0.1:7890 与 http://127.0.0.1:7890 等价）
  return (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw);
}
function getProxy() { return normalizeProxy(process.env.MUSE_PROXY); }

/* override 语义（installProxy 与 createWS 相同）：
 *   undefined -> 按 MUSE_PROXY 实时读取（原行为）
 *   null / '' -> 强制直连（不改 process.env，调用方按"模式"传参即可）
 *   字符串    -> 使用该代理地址
 * 当前 dispatcher 按代理地址缓存：地址没变就复用，变了（含 代理<->直连 切换）才新建并 close 旧的，
 * 这样直连模式下 fetch 真的直连，也不会每次调用都泄漏一个 ProxyAgent 连接池。 */
let currentDispatcher = null;
let currentKey;            // 当前 dispatcher 对应的代理地址；'' 表示直连；undefined 表示尚未安装
function resolveOverride(override) {
  return override === undefined ? getProxy() : normalizeProxy(override === null ? '' : String(override));
}

function installProxy(override) {
  const proxy = resolveOverride(override);
  const undici = require('undici');
  const key = proxy || '';
  if (key !== currentKey) {
    const old = currentDispatcher;
    currentDispatcher = proxy ? new undici.ProxyAgent(proxy) : new undici.Agent();
    currentKey = key;
    undici.setGlobalDispatcher(currentDispatcher);
    if (old) { try { Promise.resolve(old.close()).catch(() => {}); } catch {} }
  }
  globalThis.fetch = (input, init) => undici.fetch(input, init);
  return proxy;
}

function currentDispatcherInfo() { return { dispatcher: currentDispatcher, proxy: currentKey || null }; }

function createWS(url, opts = {}, override) {
  const proxy = resolveOverride(override);
  const WS = require('ws');
  const defaults = {
    origin: 'https://muse.ai',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
    },
    perMessageDeflate: false,
  };
  if (proxy) {
    const m = require('https-proxy-agent');
    const HttpsProxyAgent = m.HttpsProxyAgent || m;
    defaults.agent = new HttpsProxyAgent(proxy);
  }
  return new WS(url, { ...defaults, ...opts });
}

module.exports = { getProxy, installProxy, createWS, currentDispatcherInfo };
// 兼容旧引用：PROXY 保留为启动时快照，仅用于展示；实际出网一律走 getProxy() 实时读取
module.exports.PROXY = getProxy();
