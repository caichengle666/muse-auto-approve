'use strict';
/*
 * 统一目录布局：代码在 work/，持久化数据在 data/，日志在 log/。
 * 三个目录都位于项目根目录（本文件所在 work/ 的上一级）。
 *
 *   work/   代码模块（本文件、login-lib、muse-rpc、muse-noise、proxy、auto-approve）
 *   data/   持久化数据：凭据、会话 cookie、vmId 缓存、最近 token、pid / stop 控制文件
 *   log/    日志：daemon-log.ndjson、auto-approve-log.ndjson
 *
 * data/ 与 log/ 在首次 require 本模块时自动创建（mkdir 幂等，已存在则什么都不做），
 * 因此脚本不会因为目录缺失而写文件失败。新增文件路径请加在这里，其余模块一律引用，
 * 不要在各自的文件里再拼一遍路径。
 *
 * 可选环境变量 MUSE_DATA_DIR / MUSE_LOG_DIR 覆盖 data/、log/ 位置（离线测试用；平时不用设）。
 * data/ 存凭据与会话，新建时权限为 0700；其中的敏感文件一律经 writeSecret() 以 0600 原子写入。
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');    // 项目根目录
const WORK_DIR = path.join(ROOT_DIR, 'work');      // 代码模块
const DATA_DIR = process.env.MUSE_DATA_DIR ? path.resolve(process.env.MUSE_DATA_DIR) : path.join(ROOT_DIR, 'data');  // 持久化数据
const LOG_DIR = process.env.MUSE_LOG_DIR ? path.resolve(process.env.MUSE_LOG_DIR) : path.join(ROOT_DIR, 'log');       // 日志

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
fs.mkdirSync(LOG_DIR, { recursive: true });

/* 敏感文件写入：先写同目录临时文件（0600）再 rename，既不会被同机其他用户读到，也不会因进程被杀留下半个文件 */
function writeSecret(p, content) {
  const tmp = p + '.tmp' + process.pid + '.' + Date.now();
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);   // writeFileSync 的 mode 受 umask 影响，显式再设一次
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/* 备份文件只保留最近 keep 份（按文件名里的时间戳排序）；prefix 例如 cookies.json.bak. */
function pruneBackups(dir, prefix, keep = 2) {
  let names;
  try { names = fs.readdirSync(dir).filter(n => n.startsWith(prefix)); } catch { return; }
  names.sort((a, b) => (parseInt(a.slice(prefix.length), 10) || 0) - (parseInt(b.slice(prefix.length), 10) || 0));
  for (const n of names.slice(0, Math.max(0, names.length - keep))) { try { fs.unlinkSync(path.join(dir, n)); } catch {} }
}

module.exports = {
  ROOT_DIR,
  WORK_DIR,
  DATA_DIR,
  LOG_DIR,

  // data/ 下的文件
  CRED_PATH: path.join(DATA_DIR, 'credentials.json'),
  COOKIE_PATH: path.join(DATA_DIR, 'cookies.json'),
  VM_CONFIG_PATH: path.join(DATA_DIR, 'muse-config.json'),
  TOKEN_PATH: path.join(DATA_DIR, 'token-last.json'),
  DAEMON_PID_PATH: path.join(DATA_DIR, 'muse-daemon.pid'),
  DAEMON_STOP_PATH: path.join(DATA_DIR, 'muse-daemon.stop'),
  DAEMON_HEARTBEAT_PATH: path.join(DATA_DIR, 'muse-daemon.heartbeat'),   // 主循环每轮 touch；keepalive 据此判断假死
  LOGIN_STATE_PATH: path.join(DATA_DIR, 'login-state.json'),             // 自动登录节流/退避状态（跨进程共享）
  LOGIN_BLOCK_PATH: path.join(DATA_DIR, 'login.blocked'),                // 连续登录失败熔断标记：存在时不再自动登录、keepalive 不拉起
  AUTO_APPROVE_STOP_PATH: path.join(DATA_DIR, 'auto-approve.stop'),

  // log/ 下的文件
  DAEMON_LOG_PATH: path.join(LOG_DIR, 'daemon-log.ndjson'),
  AUTO_APPROVE_LOG_PATH: path.join(LOG_DIR, 'auto-approve-log.ndjson'),
  DAEMON_STDERR_PATH: path.join(LOG_DIR, 'daemon-stderr.log'),          // keepalive 把 daemon 的 stderr 重定向到这里

  writeSecret,
  pruneBackups,
};