'use strict';
/* keepalive.sh 离线测试：把脚本复制到临时目录，配一个只会 sleep 的假 muse-daemon.cjs，绝不运行真实守护进程 */
const { TMP } = require('./helpers.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const FAKE_DAEMON = `'use strict';
const fs = require('fs'), path = require('path');
const d = path.join(__dirname, 'data');
fs.writeFileSync(path.join(d, 'muse-daemon.pid'), String(process.pid));
fs.appendFileSync(path.join(d, 'starts.log'), process.argv.slice(2).join(' ') + '\\n');
setInterval(() => {}, 1000);
`;

const spawned = [];
function mkRoot(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'keepalive.sh'), path.join(root, 'keepalive.sh'));
  fs.chmodSync(path.join(root, 'keepalive.sh'), 0o755);
  fs.writeFileSync(path.join(root, 'muse-daemon.cjs'), FAKE_DAEMON);
  return root;
}
function starts(root) { try { return fs.readFileSync(path.join(root, 'data/starts.log'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }
function run(root, env = {}) {
  return spawnSync(path.join(root, 'keepalive.sh'), [], {
    // 精简 PATH（模拟 cron）：PATH 里没有 node，只能靠 NODE_BIN 绝对路径
    env: { PATH: '/usr/bin:/bin', HOME: path.join(TMP, 'nohome'), MUSE_KEEPALIVE_WAIT_SEC: '1', ...env },
    encoding: 'utf8', timeout: 30000,
  });
}
function killDaemon(root) {
  try { const pid = parseInt(fs.readFileSync(path.join(root, 'data/muse-daemon.pid'), 'utf8'), 10); if (pid) process.kill(pid, 'SIGKILL'); } catch {}
}

test.after(() => { for (const p of spawned) { try { p.kill('SIGKILL'); } catch {} } });

test('keepalive.sh 本身可执行（git 里是 100755）', () => {
  const r = spawnSync('git', ['ls-files', '-s', 'keepalive.sh'], { cwd: REPO, encoding: 'utf8' });
  assert.match(r.stdout, /^100755 /);
  assert.equal(spawnSync('bash', ['-n', path.join(REPO, 'keepalive.sh')]).status, 0);
});

test('cron 精简 PATH 下用 NODE_BIN 绝对路径拉起；再次调用时识别存活不重复拉起', () => {
  const root = mkRoot('ka-start');
  try {
    const r = run(root, { NODE_BIN: process.execPath });
    assert.equal(r.status, 0, r.stderr + fs.readFileSync(path.join(root, 'log/keepalive.log'), 'utf8'));
    assert.equal(starts(root), 1);
    assert.match(fs.readFileSync(path.join(root, 'data/starts.log'), 'utf8'), /--loop 10000 --always --fallback-once/);
    assert.equal(run(root, { NODE_BIN: process.execPath }).status, 0);
    assert.equal(starts(root), 1, '已存活时不应再拉起');
  } finally { killDaemon(root); }
});

/* 造一个只含常用工具、不含 node 的 PATH 目录（模拟 cron + nvm 用户） */
function toolsDirWithoutNode() {
  const dir = path.join(TMP, 'tools');
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(dir);
  for (const t of ['mkdir', 'date', 'wc', 'tail', 'mv', 'ls', 'sort', 'tr', 'readlink', 'basename', 'dirname', 'pgrep', 'ps', 'find', 'stat', 'sleep', 'flock', 'cat', 'rm', 'nohup', 'setsid']) {
    const r = spawnSync('bash', ['-c', 'command -v ' + t], { encoding: 'utf8' });
    const src = r.stdout.trim();
    if (r.status === 0 && src.startsWith('/')) fs.symlinkSync(src, path.join(dir, t));
  }
  return dir;
}

test('PATH 里没有 node 时能找到 nvm 安装的 node（取最高版本）', () => {
  const root = mkRoot('ka-nvm');
  const home = path.join(TMP, 'nvmhome');
  for (const v of ['v20.18.0', 'v22.3.0', 'v9.0.0']) {
    const bin = path.join(home, '.nvm/versions/node', v, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  }
  try {
    const r = spawnSync(path.join(root, 'keepalive.sh'), [], { env: { PATH: toolsDirWithoutNode(), HOME: home, MUSE_KEEPALIVE_WAIT_SEC: '1' }, encoding: 'utf8', timeout: 30000 });
    const log = fs.readFileSync(path.join(root, 'log/keepalive.log'), 'utf8');
    assert.equal(r.status, 0, log + r.stderr);
    assert.match(log, /\.nvm\/versions\/node\/v22\.3\.0\/bin\/node/, log);
    assert.equal(starts(root), 1);
  } finally { killDaemon(root); }
});

test('完全找不到 node 时写明原因并退出 1（不再静默失败）', () => {
  const root = mkRoot('ka-nonode2');
  const r = spawnSync(path.join(root, 'keepalive.sh'), [], { env: { PATH: toolsDirWithoutNode(), HOME: path.join(TMP, 'emptyhome'), MUSE_KEEPALIVE_WAIT_SEC: '1' }, encoding: 'utf8', timeout: 30000 });
  const log = fs.readFileSync(path.join(root, 'log/keepalive.log'), 'utf8');
  if (fs.existsSync('/usr/local/bin/node') || fs.existsSync('/usr/bin/node') || fs.existsSync('/opt/homebrew/bin/node')) {
    // 常见安装位置兜底能找到 node：也算找到
    assert.equal(r.status, 0, log);
    killDaemon(root);
  } else {
    assert.equal(r.status, 1);
    assert.match(log, /node not found/);
  }
});

test('存在 stop 文件 / 登录熔断文件时不拉起', () => {
  const root = mkRoot('ka-stop');
  fs.writeFileSync(path.join(root, 'data/muse-daemon.stop'), '');
  assert.equal(run(root, { NODE_BIN: process.execPath }).status, 0);
  assert.equal(starts(root), 0);
  fs.unlinkSync(path.join(root, 'data/muse-daemon.stop'));
  fs.writeFileSync(path.join(root, 'data/login.blocked'), '{}');
  assert.equal(run(root, { NODE_BIN: process.execPath }).status, 0);
  assert.equal(starts(root), 0);
  assert.match(fs.readFileSync(path.join(root, 'log/keepalive.log'), 'utf8'), /login\.blocked/);
});

test('别处克隆的 muse-daemon.cjs 进程不会被误判为本目录存活（pgrep 限定本目录）', async () => {
  const other = mkRoot('ka-other');
  const root = mkRoot('ka-mine');
  // 另一个目录里的"daemon"在跑（命令行同样含 muse-daemon.cjs）
  const p = spawn(process.execPath, [path.join(other, 'muse-daemon.cjs')], { stdio: 'ignore', detached: false });
  spawned.push(p);
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync(path.join(root, 'data/muse-daemon.pid'), String(p.pid));   // 甚至 pid 文件指向它
  try {
    const r = run(root, { NODE_BIN: process.execPath });
    assert.equal(r.status, 0, fs.readFileSync(path.join(root, 'log/keepalive.log'), 'utf8'));
    assert.equal(starts(root), 1, '应拉起本目录自己的 daemon');
  } finally { killDaemon(root); p.kill('SIGKILL'); }
});

test('flock 防并发：锁被占用时直接跳过', { skip: spawnSync('bash', ['-c', 'command -v flock']).status !== 0 && '无 flock' }, async () => {
  const root = mkRoot('ka-lock');
  const holder = spawn('flock', [path.join(root, 'data/keepalive.lock'), 'sleep', '5'], { stdio: 'ignore' });
  spawned.push(holder);
  await new Promise(r => setTimeout(r, 300));
  try {
    const r = run(root, { NODE_BIN: process.execPath });
    assert.equal(r.status, 0);
    assert.equal(starts(root), 0, '拿不到锁时不应拉起');
  } finally { holder.kill('SIGKILL'); }
});

test('心跳停滞（假死）时杀掉重拉', () => {
  const root = mkRoot('ka-stale');
  try {
    assert.equal(run(root, { NODE_BIN: process.execPath }).status, 0);
    assert.equal(starts(root), 1);
    const old = parseInt(fs.readFileSync(path.join(root, 'data/muse-daemon.pid'), 'utf8'), 10);
    const hb = path.join(root, 'data/muse-daemon.heartbeat');
    fs.writeFileSync(hb, '');
    const past = new Date(Date.now() - 3600e3); fs.utimesSync(hb, past, past);
    spawnSync('sleep', ['1.2']);
    const r = run(root, { NODE_BIN: process.execPath, MUSE_KEEPALIVE_STALE_SEC: '0' });
    assert.equal(r.status, 0, fs.readFileSync(path.join(root, 'log/keepalive.log'), 'utf8'));
    assert.equal(starts(root), 2);
    let alive = true; try { process.kill(old, 0); } catch { alive = false; }
    assert.equal(alive, false, '旧进程应被杀掉');
  } finally { killDaemon(root); }
});
