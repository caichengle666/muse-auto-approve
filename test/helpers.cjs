'use strict';
/* 测试公共设置：把 data/、log/ 指到临时目录，绝不碰仓库里的真实会话；禁止任何真实出网 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-aa-test-'));
process.env.MUSE_DATA_DIR = path.join(TMP, 'data');
process.env.MUSE_LOG_DIR = path.join(TMP, 'log');
process.env.MUSE_TOKEN_RETRY_MS = '1';
delete process.env.MUSE_PROXY;
delete process.env.MUSE_USER; delete process.env.MUSE_EMAIL; delete process.env.MUSE_PASSWORD;
delete process.env.MUSE_VM_ID;

/* 任何未被测试显式替换的 fetch 都直接失败，保证不会访问线上服务 */
function blockNetwork() {
  globalThis.fetch = async (url) => { throw new Error('network disabled in tests: ' + url); };
}

function fakeResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || null, getSetCookie: () => headers['set-cookie'] || [] },
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

module.exports = { TMP, blockNetwork, fakeResponse };
