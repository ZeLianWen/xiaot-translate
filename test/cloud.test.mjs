/**
 * Supabase 链路测试 (V1.5.51): supabase-auth.js + cloud-sync.js
 * 运行: node --test test/
 * 全部请求经 fetch 打桩 + chrome.storage.local 内存桩, 零真实网络。
 * 验证: 请求形态(URL/方法/头/体)、会话归一化与自动续期、错误映射、
 *       云端上传配额预检/孤儿清理、列表字段映射、删除/清空链路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signIn, signUp, signOut, getValidSession, validateCredentials,
  updatePassword, requestPasswordReset, resetPasswordWithCode,
  resetPasswordWithLink, parseResetProof, resetPasswordWithProof,
  SUPABASE_ANON_KEY
} from '../lib/supabase-auth.js';
import {
  CLOUD_QUOTA, cloudUploadRecord, cloudListRecords, cloudDownloadRecord,
  cloudDeleteRecord, cloudQuotaUsage, cloudClearAll, cloudPushAll, cloudPullMissing
} from '../lib/cloud-sync.js';
import { getEntitlement, clearEntitlementCache, FREE_ENTITLEMENT } from '../lib/entitlement.js';
import { historyAll } from '../lib/cache.js';

// ===== 桩: chrome.storage.local (内存 Map) =====
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const out = {};
        for (const k of (Array.isArray(keys) ? keys : [keys])) {
          if (store.has(k)) out[k] = store.get(k);
        }
        return out;
      },
      async set(obj) { for (const k of Object.keys(obj)) store.set(k, obj[k]); },
      async remove(key) { store.delete(key); }
    }
  }
};

// ===== 桩: fetch (路由表 + 调用记录) =====
// route: { match(url, opts), respond(url, opts) → ResponseLike }
function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {} });
    for (const r of routes) {
      if (r.match(u, opts || {})) return r.respond(u, opts || {});
    }
    throw new Error('未打桩的请求: ' + u);
  };
  return calls;
}

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: async () => obj,
    text: async () => (obj === null ? '' : JSON.stringify(obj)),
    arrayBuffer: async () => new TextEncoder().encode(obj === null ? '' : JSON.stringify(obj)).buffer
  };
}

// 会话/认证载荷夹具
const AUTH_PAYLOAD = {
  access_token: 'at-1', refresh_token: 'rt-1',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: 'user-9', email: 'a@b.c' }
};
const VALID_SESSION = {
  accessToken: 'tok-abc', refreshToken: 'r1',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  userId: 'user-1', email: 'a@b.c', time: Date.now()
};

// 未登录基线路由 (任何触网的用例都自带完整路由表, 此项仅防御)
test('未登录基线: 云端各操作统一返回 { ok:false, error:"未登录" }, 零网络请求', async () => {
  const calls = installFetch([]);
  store.clear();
  assert.deepEqual(await cloudQuotaUsage(), { ok: false, error: '未登录' });
  assert.deepEqual(await cloudListRecords(), { ok: false, error: '未登录' });
  assert.deepEqual(await cloudDeleteRecord('x'), { ok: false, error: '未登录' });
  assert.deepEqual(await cloudClearAll(), { ok: false, error: '未登录' });
  assert.equal(calls.length, 0, '未登录时不应发起任何请求');
});

// ===== supabase-auth =====

test('validateCredentials: 邮箱格式 / 密码长度', () => {
  assert.equal(validateCredentials('bad-email', '123456'), '邮箱格式不正确');
  assert.equal(validateCredentials('a@b.c', '12345'), '密码至少 6 位');
  assert.equal(validateCredentials('a@b.c', '123456'), null);
});

test('signIn: 请求形态 (grant_type=password + apikey 头) 与会话归一化落库', async () => {
  store.clear();
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/token?grant_type=password'), respond: () => jsonResponse(AUTH_PAYLOAD) }
  ]);
  const s = await signIn('a@b.c', '123456');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['apikey'], SUPABASE_ANON_KEY);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { email: 'a@b.c', password: '123456' });
  // 归一化字段名 + 写入 chrome.storage.local 的 vtAuthSession
  assert.equal(s.accessToken, 'at-1');
  assert.equal(s.refreshToken, 'rt-1');
  assert.equal(s.userId, 'user-9');
  assert.equal(s.email, 'a@b.c');
  assert.equal(store.get('vtAuthSession').accessToken, 'at-1');
});

test('signIn 失败: 服务端错误码映射为可读中文', async () => {
  store.clear();
  const cases = [
    [{ error_code: 'invalid_login_credentials' }, 400, '邮箱或密码错误'],
    [{ error_code: 'user_already_exists' }, 400, '该邮箱已注册，请直接登录'],
    [{ error_description: 'Email not confirmed' }, 400, '邮箱尚未验证：请先到注册邮箱点击验证链接'],
    [{ msg: 'Signups not allowed' }, 403, '该邮箱域名不允许注册'],
    [{ message: 'failed' }, 429, '请求过于频繁，请稍后再试'],
    [{ error_description: 'Password should be at least 6 characters' }, 400, '密码强度不足（至少 6 位）'],
    [{ error_code: 'same_password', msg: 'New password should be different from the old password.' }, 400, '新密码不能与旧密码相同'],
    [{ error_code: 'recent_authentication_required', msg: 'User should have been recently authenticated' }, 400, '出于安全要求，请先退出登录并重新登录一次，再修改密码'],
    [{ error_code: 'otp_expired', msg: 'Token has expired or is invalid' }, 400, '验证码错误或已过期']
  ];
  for (const [body, status, expected] of cases) {
    installFetch([
      { match: u => u.includes('/auth/v1/token'), respond: () => jsonResponse(body, status) }
    ]);
    await assert.rejects(() => signIn('a@b.c', '123456'), new RegExp(expected));
  }
});

test('signUp: 两种注册形态 (即时登录 / 需邮箱验证)', async () => {
  // 关闭邮箱验证 → 返回 access_token → 自动登录
  store.clear();
  installFetch([
    { match: u => u.includes('/auth/v1/signup'), respond: () => jsonResponse(AUTH_PAYLOAD) }
  ]);
  let r = await signUp('a@b.c', '123456');
  assert.equal(r.needsConfirm, false);
  assert.equal(r.session.accessToken, 'at-1');
  // 开启邮箱验证 → 无 access_token → 需确认, 不落会话
  store.clear();
  installFetch([
    { match: u => u.includes('/auth/v1/signup'), respond: () => jsonResponse({ id: 'x' }) }
  ]);
  r = await signUp('a@b.c', '123456');
  assert.equal(r.needsConfirm, true);
  assert.equal(r.session, null);
  assert.equal(store.has('vtAuthSession'), false, '待验证注册不应写入会话');
});

test('getValidSession: 未过期直接返回 (零请求); 临近过期自动续期并落库', async () => {
  // 未过期: 不发任何请求
  store.clear();
  store.set('vtAuthSession', { ...VALID_SESSION });
  const calls = installFetch([]);
  const s1 = await getValidSession();
  assert.equal(s1.accessToken, 'tok-abc');
  assert.equal(calls.length, 0, '未过期不应触发续期请求');

  // 临近过期 (< 60s 余量): 用 refresh_token 续期
  const near = { ...VALID_SESSION, expiresAt: Math.floor(Date.now() / 1000) + 30 };
  store.set('vtAuthSession', near);
  installFetch([
    { match: u => u.includes('/auth/v1/token?grant_type=refresh_token'), respond: () => jsonResponse(AUTH_PAYLOAD) }
  ]);
  const s2 = await getValidSession();
  assert.equal(s2.accessToken, 'at-1', '应返回续期后的新会话');
  assert.equal(store.get('vtAuthSession').accessToken, 'at-1', '新会话应已落库');
});

test('getValidSession: 续期失败 (刷新令牌失效) 清空本地会话并返回 null', async () => {
  store.clear();
  store.set('vtAuthSession', { ...VALID_SESSION, expiresAt: Math.floor(Date.now() / 1000) + 30 });
  installFetch([
    { match: u => u.includes('/auth/v1/token'), respond: () => jsonResponse({ error_code: 'invalid_login_credentials' }, 400) }
  ]);
  const s = await getValidSession();
  assert.equal(s, null);
  assert.equal(store.has('vtAuthSession'), false, '续期失败应清除本地会话');
});

test('getValidSession: 续期遇瞬时错误 (HTTP 500/网络) 保留本地会话, 仅本次返回 null (V1.5.55)', async () => {
  // HTTP 500: 服务端内部错误, refresh_token 仍有效
  store.clear();
  store.set('vtAuthSession', { ...VALID_SESSION, expiresAt: Math.floor(Date.now() / 1000) + 30 });
  installFetch([
    { match: u => u.includes('/auth/v1/token'), respond: () => jsonResponse({ message: 'boom' }, 500) }
  ]);
  let s = await getValidSession();
  assert.equal(s, null, '瞬时错误本次返回 null');
  assert.equal(store.has('vtAuthSession'), true, '会话应保留供下次重试');
  assert.equal(store.get('vtAuthSession').accessToken, 'tok-abc');
  // 网络错误 (fetch 抛 TypeError)
  installFetch([
    { match: u => u.includes('/auth/v1/token'), respond: () => { throw new TypeError('Failed to fetch'); } }
  ]);
  s = await getValidSession();
  assert.equal(s, null);
  assert.equal(store.has('vtAuthSession'), true, '网络错误同样保留会话');
});

test('getValidSession: 并发续期去重——同时多次调用只发一次刷新请求 (V1.5.55)', async () => {
  store.clear();
  store.set('vtAuthSession', { ...VALID_SESSION, expiresAt: Math.floor(Date.now() / 1000) + 30 });
  let refreshCalls = 0;
  installFetch([
    { match: u => u.includes('/auth/v1/token?grant_type=refresh_token'), respond: () => { refreshCalls++; return jsonResponse(AUTH_PAYLOAD); } }
  ]);
  const [a, b] = await Promise.all([getValidSession(), getValidSession()]);
  assert.equal(refreshCalls, 1, '并发续期复用同一 in-flight 请求, 防止 refresh_token 被并发使用遭服务端吊销');
  assert.equal(a.accessToken, 'at-1');
  assert.equal(b.accessToken, 'at-1');
});

test('signOut: 吊销服务端令牌 + 清空本地; 网络失败也保证本地登出', async () => {
  // 正常: POST /logout 带 Bearer, 清 storage
  store.clear();
  store.set('vtAuthSession', { ...VALID_SESSION });
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/logout'), respond: () => jsonResponse(null, 204) }
  ]);
  await signOut();
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['Authorization'], 'Bearer tok-abc');
  assert.equal(store.has('vtAuthSession'), false);

  // 网络失败: 服务端吊销不成功, 本地仍须登出
  store.set('vtAuthSession', { ...VALID_SESSION });
  installFetch([
    { match: () => true, respond: () => { throw new TypeError('Failed to fetch'); } }
  ]);
  await signOut();
  assert.equal(store.has('vtAuthSession'), false, '网络失败也应清空本地会话');
});

// ===== 密码管理 (修改密码 / 忘记密码, V1.7.5) =====

test('updatePassword: PUT /auth/v1/user (Bearer + 新密码); 密码过短/未登录本地拒绝零网络', async () => {
  login();
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({ id: 'user-1' }) }
  ]);
  await updatePassword('newpass123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, 'PUT');
  assert.equal(calls[0].opts.headers['Authorization'], 'Bearer tok-abc');
  assert.equal(calls[0].opts.headers['apikey'], SUPABASE_ANON_KEY);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { password: 'newpass123' });
  // 密码过短: 本地拒绝, 零网络
  const callsShort = installFetch([]);
  await assert.rejects(() => updatePassword('123'), /新密码至少 6 位/);
  assert.equal(callsShort.length, 0);
  // 未登录: 本地拒绝, 零网络
  store.clear();
  const callsOut = installFetch([]);
  await assert.rejects(() => updatePassword('newpass123'), /登录状态已失效/);
  assert.equal(callsOut.length, 0);
});

test('updatePassword: 会话临近过期先自动续期, 以续期后的新令牌改密 (V1.7.5)', async () => {
  store.clear();
  store.set('vtAuthSession', { ...VALID_SESSION, expiresAt: Math.floor(Date.now() / 1000) + 30 });
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/token?grant_type=refresh_token'), respond: () => jsonResponse(AUTH_PAYLOAD) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({ id: 'user-9' }) }
  ]);
  await updatePassword('newpass123');
  assert.equal(calls.length, 2, '续期 + 改密恰好 2 次请求');
  assert.equal(calls[1].opts.method, 'PUT');
  assert.equal(calls[1].opts.headers['Authorization'], 'Bearer at-1', '改密应使用续期后的新令牌而非过期旧令牌');
  assert.equal(store.get('vtAuthSession').accessToken, 'at-1', '续期会话应已落库');
});

test('requestPasswordReset: POST /auth/v1/recover {email} (去空白); 邮箱格式本地校验零网络', async () => {
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/recover'), respond: () => jsonResponse({}) }
  ]);
  await requestPasswordReset('  a@b.c  ');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { email: 'a@b.c' });
  // 邮箱格式非法: 本地拒绝, 零网络
  const calls2 = installFetch([]);
  await assert.rejects(() => requestPasswordReset('bad-email'), /邮箱格式不正确/);
  assert.equal(calls2.length, 0);
});

test('resetPasswordWithCode: verify(recovery) 建会话 → PUT 新密码 → 自动登录; 失败路径各自可读', async () => {
  // 全链路成功: 验证码校验 → 会话落库 → 新密码写入 → 返回会话
  store.clear();
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse(AUTH_PAYLOAD) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({ id: 'user-9' }) }
  ]);
  const s = await resetPasswordWithCode('a@b.c', '123456', 'newpass123');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { type: 'recovery', email: 'a@b.c', token: '123456' });
  assert.equal(calls[1].opts.method, 'PUT');
  assert.equal(calls[1].opts.headers['Authorization'], 'Bearer at-1', '新密码写入用 verify 返回的新会话令牌');
  assert.equal(s.accessToken, 'at-1');
  assert.equal(store.get('vtAuthSession').accessToken, 'at-1');
  // 验证码错误/过期: 服务端错误映射可读, 不落会话
  store.clear();
  const calls2 = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse({ error_code: 'otp_expired', msg: 'Token has expired or is invalid' }, 400) }
  ]);
  await assert.rejects(() => resetPasswordWithCode('a@b.c', '000000', 'newpass123'), /验证码错误或已过期/);
  assert.equal(calls2.length, 1);
  assert.equal(store.has('vtAuthSession'), false, '验证码校验失败不应落会话');
  // 新密码写入失败 (如与旧密码相同): 回滚刚建立的半登录会话
  store.clear();
  const calls3 = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse(AUTH_PAYLOAD) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({ error_code: 'same_password', msg: 'New password should be different from the old password.' }, 400) }
  ]);
  await assert.rejects(() => resetPasswordWithCode('a@b.c', '123456', 'newpass123'), /新密码不能与旧密码相同/);
  assert.equal(calls3.length, 2);
  assert.equal(store.has('vtAuthSession'), false, '密码未改成应回滚半登录会话');
  // 验证码格式非法: 本地拒绝, 零网络
  const calls4 = installFetch([]);
  await assert.rejects(() => resetPasswordWithCode('a@b.c', '12ab56', 'newpass123'), /6~8 位数字/);
  assert.equal(calls4.length, 0);
  // verify 成功但响应无会话 (异常防御): 可读报错, 不落会话、不发改密请求
  store.clear();
  const calls5 = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse({ id: 'x' }) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({}) }
  ]);
  await assert.rejects(() => resetPasswordWithCode('a@b.c', '123456', 'newpass123'), /服务端未返回会话/);
  assert.equal(calls5.length, 1, '无会话时不应发起改密请求');
  assert.equal(store.has('vtAuthSession'), false);
});

// V1.7.7: 免费版默认发信只发「链接」, 扩展支持把链接粘进来 (token_hash 换会话)
// 用例固定值 (56 位 hex, 与 Supabase token_hash 同形态), 不含任何真实令牌
const RESET_HASH = 'deadbeef'.repeat(7);
const RESET_LINK = 'https://demo-project.supabase.co/auth/v1/verify?token=' + RESET_HASH + '&type=recovery&redirect_to=http://localhost:3000';

test('parseResetProof: 验证码 / 重置链接 / 裸 token 识别, 垃圾输入返回 null (V1.7.7)', () => {
  assert.deepEqual(parseResetProof('123456'), { kind: 'code', value: '123456' });
  assert.deepEqual(parseResetProof(' 12345678 '), { kind: 'code', value: '12345678' });
  assert.deepEqual(parseResetProof(RESET_LINK), { kind: 'token_hash', value: RESET_HASH }, '标准 verify 链接');
  assert.deepEqual(
    parseResetProof('https://x.supabase.co/auth/confirm?token_hash=abc_-123&type=recovery'),
    { kind: 'token_hash', value: 'abc_-123' },
    '新版 token_hash 形态链接'
  );
  assert.deepEqual(parseResetProof(RESET_HASH), { kind: 'token_hash', value: RESET_HASH }, '只粘 token 本身也可');
  assert.equal(parseResetProof('hello'), null);
  assert.equal(parseResetProof('12ab56'), null, '带字母的 6 位不是验证码');
  assert.equal(parseResetProof(''), null);
  assert.equal(parseResetProof(null), null);
});

test('parseResetProof 边界: 邮件 HTML 转义 / 反代域 / 片段 / 包裹与换行 / 位数与长度 (V1.7.7)', () => {
  // 从邮件 HTML 源码复制时 & 被转义成 &amp;, 且 token 不在首位 (真实场景最常见)
  assert.deepEqual(
    parseResetProof('https://x.supabase.co/auth/v1/verify?type=recovery&amp;token=abc_DEF-123&amp;redirect_to=http://localhost:3000'),
    { kind: 'token_hash', value: 'abc_DEF-123' },
    '&amp; 转义且 token 不在首位'
  );
  // 自定义反代域 (扩展实际使用的 sb.xiaoti.click)
  assert.deepEqual(
    parseResetProof('https://sb.xiaoti.click/auth/v1/verify?token=' + RESET_HASH + '&type=recovery'),
    { kind: 'token_hash', value: RESET_HASH }
  );
  // 片段形态 #token=
  assert.deepEqual(
    parseResetProof('https://x/auth/v1/verify#token=' + RESET_HASH + '&type=recovery'),
    { kind: 'token_hash', value: RESET_HASH }
  );
  // 被尖括号/引号包裹、前后带换行 (从客户端复制粘贴常见)
  assert.deepEqual(
    parseResetProof('  <https://x/auth/v1/verify?token=' + RESET_HASH + '&type=recovery>\n'),
    { kind: 'token_hash', value: RESET_HASH }
  );
  assert.deepEqual(
    parseResetProof('\n\n"https://x/auth/v1/verify?token=' + RESET_HASH + '&type=recovery"\n'),
    { kind: 'token_hash', value: RESET_HASH }
  );
  // 位数边界: 5 位/9 位数字既不是验证码也不是 token
  assert.equal(parseResetProof('12345'), null);
  assert.equal(parseResetProof('123456789'), null);
  // 裸 token 边界: 39 位不是 token, 40 位 base64url 是
  assert.equal(parseResetProof('a'.repeat(39)), null);
  assert.deepEqual(parseResetProof('a'.repeat(40)), { kind: 'token_hash', value: 'a'.repeat(40) });
  assert.deepEqual(
    parseResetProof('AbC-_'.repeat(9)),
    { kind: 'token_hash', value: 'AbC-_'.repeat(9) },
    'base64url 字符集 (新旧版本 token 形态兼容)'
  );
});

test('resetPasswordWithLink: token_hash 换会话 → PUT 新密码 (不带 email); 过期/本地校验可读 (V1.7.7)', async () => {
  // 全链路成功: 链接提取 token_hash → verify → 会话落库 → 新密码写入 → 自动登录
  store.clear();
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse(AUTH_PAYLOAD) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({ id: 'user-9' }) }
  ]);
  const s = await resetPasswordWithLink(RESET_LINK, 'newpass123');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.method, 'POST');
  // verify 只接受 token_hash + type (带 email 会被 GoTrue 400 拒绝)
  assert.deepEqual(JSON.parse(calls[0].opts.body), { type: 'recovery', token_hash: RESET_HASH });
  assert.equal(calls[1].opts.method, 'PUT');
  assert.equal(calls[1].opts.headers['Authorization'], 'Bearer at-1');
  assert.equal(s.accessToken, 'at-1');
  assert.equal(store.get('vtAuthSession').accessToken, 'at-1');
  // 链接已用/超时: 映射为专门的中文引导, 不落会话
  store.clear();
  const calls2 = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse({ code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' }, 403) }
  ]);
  await assert.rejects(() => resetPasswordWithLink(RESET_LINK, 'newpass123'), /重置链接无效或已过期/);
  assert.equal(calls2.length, 1);
  assert.equal(store.has('vtAuthSession'), false);
  // 新密码写入失败 (与旧密码相同): 回滚半登录会话
  store.clear();
  const calls3 = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse(AUTH_PAYLOAD) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({ error_code: 'same_password', msg: 'New password should be different from the old password.' }, 400) }
  ]);
  await assert.rejects(() => resetPasswordWithLink(RESET_LINK, 'newpass123'), /新密码不能与旧密码相同/);
  assert.equal(calls3.length, 2);
  assert.equal(store.has('vtAuthSession'), false, '密码未改成应回滚半登录会话');
  // verify 成功但无会话 (异常防御)
  store.clear();
  const calls4 = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse({ id: 'x' }) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({}) }
  ]);
  await assert.rejects(() => resetPasswordWithLink(RESET_LINK, 'newpass123'), /重置链接无效或已过期/);
  assert.equal(calls4.length, 1, '无会话时不应发起改密请求');
  // 本地校验零网络: 垃圾输入 / 把验证码误填进链接入口 / 密码过短
  const calls5 = installFetch([]);
  await assert.rejects(() => resetPasswordWithLink('hello', 'newpass123'), /链接无效/);
  await assert.rejects(() => resetPasswordWithLink('123456', 'newpass123'), /链接无效/);
  await assert.rejects(() => resetPasswordWithLink(RESET_LINK, '123'), /新密码至少 6 位/);
  assert.equal(calls5.length, 0);
});

test('resetPasswordWithLink: 网络失败与参数错误原样透出 (不被误报为"链接无效") (V1.7.7)', async () => {
  // 网络抖动: TypeError 由 sbFetch 抛出, 不能被重置链接的过期映射吞掉
  store.clear();
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => { throw new TypeError('Failed to fetch'); } }
  ]);
  await assert.rejects(() => resetPasswordWithLink(RESET_LINK, 'newpass123'), (e) => {
    assert.match(e.message, /Failed to fetch/);
    assert.doesNotMatch(e.message, /链接无效|已过期/, '网络错误不应被包装成链接失效');
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(store.has('vtAuthSession'), false);

  // 服务端参数错误 (如误带 email 时 GoTrue 的 400): 原样透出描述, 便于排障
  store.clear();
  installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse({ code: 400, error_code: 'validation_failed', msg: 'Only the token_hash and type should be provided' }, 400) }
  ]);
  await assert.rejects(() => resetPasswordWithLink(RESET_LINK, 'newpass123'), /Only the token_hash and type/);
  assert.equal(store.has('vtAuthSession'), false);
});

test('resetPasswordWithCode: 8 位验证码同样走 email+token 链路 (服务端 otp_length 可配) (V1.7.7)', async () => {
  store.clear();
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse(AUTH_PAYLOAD) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({ id: 'user-9' }) }
  ]);
  const s = await resetPasswordWithCode('a@b.c', '12345678', 'newpass123');
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { type: 'recovery', email: 'a@b.c', token: '12345678' });
  assert.equal(s.accessToken, 'at-1');
});

test('resetPasswordWithProof: 验证码/链接自动分派, 会话字段完整, 未识别输入与短密码零网络 (V1.7.7)', async () => {
  // 验证码分支: email 去空白后透传, 会话完整归一化 (refreshToken/userId/email)
  store.clear();
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse(AUTH_PAYLOAD) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({ id: 'user-9' }) }
  ]);
  const s = await resetPasswordWithProof('  123456  ', '  a@b.c  ', 'newpass123');
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { type: 'recovery', email: 'a@b.c', token: '123456' });
  assert.equal(s.accessToken, 'at-1');
  assert.equal(s.refreshToken, 'rt-1');
  assert.equal(s.userId, 'user-9');
  assert.equal(s.email, 'a@b.c');
  assert.equal(store.get('vtAuthSession').refreshToken, 'rt-1');

  // 链接分支: 邮件 HTML 转义的 &amp; 链接也能提取 token, 且不带 email
  store.clear();
  const calls2 = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse(AUTH_PAYLOAD) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({ id: 'user-9' }) }
  ]);
  await resetPasswordWithProof(
    'https://x.supabase.co/auth/v1/verify?type=recovery&amp;token=' + RESET_HASH + '&amp;redirect_to=http://localhost:3000',
    '',
    'newpass123'
  );
  assert.equal(calls2.length, 2);
  assert.deepEqual(JSON.parse(calls2[0].opts.body), { type: 'recovery', token_hash: RESET_HASH }, '链接分支不带 email');

  // 无法识别 / 密码过短: 本地拒绝, 零网络
  const calls3 = installFetch([]);
  await assert.rejects(() => resetPasswordWithProof('hello', 'a@b.c', 'newpass123'), /请粘贴邮件里的重置链接/);
  await assert.rejects(() => resetPasswordWithProof('123456', 'a@b.c', '123'), /新密码至少 6 位/);
  assert.equal(calls3.length, 0);
});

test('重置密码失败路径: 弱密码与 429 映射可读且不落会话 (V1.7.7)', async () => {
  // 验证码链路: 服务端判定密码过弱 → 可读提示 + 回滚半登录会话
  store.clear();
  const calls = installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse(AUTH_PAYLOAD) },
    { match: u => u.includes('/auth/v1/user'), respond: () => jsonResponse({ error_code: 'weak_password', msg: 'Password should be at least 6 characters.' }, 400) }
  ]);
  await assert.rejects(() => resetPasswordWithCode('a@b.c', '123456', 'newpass123'), /密码强度不足/);
  assert.equal(calls.length, 2);
  assert.equal(store.has('vtAuthSession'), false, '密码未改成应回滚半登录会话');

  // 链接链路: 频率限制 → 中文提示, 不落会话
  store.clear();
  installFetch([
    { match: u => u.includes('/auth/v1/verify'), respond: () => jsonResponse({ code: 429, error_code: 'over_email_send_rate_limit', msg: 'over email send rate limit' }, 429) }
  ]);
  await assert.rejects(() => resetPasswordWithLink(RESET_LINK, 'newpass123'), /请求过于频繁/);
  assert.equal(store.has('vtAuthSession'), false);
});

// ===== cloud-sync =====
test('CLOUD_QUOTA 常量: 30 条 / 50MB / 单 PDF 20MB', () => {
  assert.equal(CLOUD_QUOTA.maxRecords, 30);
  assert.equal(CLOUD_QUOTA.maxBytes, 50 * 1024 * 1024);
  assert.equal(CLOUD_QUOTA.maxFileBytes, 20 * 1024 * 1024);
});

function login() {
  store.clear();
  store.set('vtAuthSession', { ...VALID_SESSION });
  // 套餐缓存预置 (V1.6.1 阶段1): getEntitlement 命中缓存零网络, 已有配额用例不受影响;
  // 套餐相关新用例自行覆盖/删除此键后走网络路径
  store.set('vtEntitlement', {
    userId: VALID_SESSION.userId,
    fetchedAt: Date.now(),
    value: { plan: 'free', maxRecords: 30, maxBytes: 50 * 1024 * 1024, expiresAt: null }
  });
}

// 配额查询路由 (quotaOf): rows 形如 [{id, total_bytes}]
function quotaRoute(rows) {
  return {
    match: u => u.includes('/rest/v1/history?select=id,total_bytes'),
    respond: () => jsonResponse(rows)
  };
}

const REC = {
  id: 'rec-1',
  fileName: 'paper.pdf',
  time: 1700000000000,
  backend: 'baidu',
  srcLabel: '英语',
  tgtLabel: '中文',
  pageCount: 3,
  pdfBlob: new Blob(['%PDF-fake-body'], { type: 'application/pdf' }),
  pages: ['p1'],
  translatedPages: ['t1'],
  stats: { localChars: 1 },
  annotations: []
};

function uploadRoutes(quotaRows) {
  return [
    quotaRoute(quotaRows || []),
    { match: u => u.includes('/storage/v1/object/history/'), respond: () => jsonResponse({ Key: 'k' }) },
    { match: u => u.includes('/rest/v1/history'), respond: () => jsonResponse({}) }
  ];
}

test('cloudUploadRecord 全链路: 配额预检 → PDF 上桶(x-upsert) → 行 upsert(merge-duplicates), 配额快照累加', async () => {
  login();
  const calls = installFetch(uploadRoutes());
  const q = { count: 0, bytes: 0, ids: new Set() };
  const r = await cloudUploadRecord(REC, VALID_SESSION, q);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2, 'quotaHint 已传入时零预检请求, 恰好 PDF+行 2 次上传请求');
  // 1. PDF → 私有桶, 路径含 userId/记录id, x-upsert 覆盖语义
  assert.ok(calls[0].url.endsWith('/storage/v1/object/history/user-1/rec-1.pdf'), calls[0].url);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['x-upsert'], 'true');
  assert.equal(calls[0].opts.headers['Authorization'], 'Bearer tok-abc');
  // 2. 行记录 upsert: snake_case 字段 + Prefer merge-duplicates + total_bytes 只计 PDF 体积
  assert.ok(calls[1].url.endsWith('/rest/v1/history'));
  assert.equal(calls[1].opts.headers['Prefer'], 'resolution=merge-duplicates');
  const row = JSON.parse(calls[1].opts.body);
  assert.equal(row.id, 'rec-1');
  assert.equal(row.file_name, 'paper.pdf');
  assert.equal(row.total_bytes, REC.pdfBlob.size, '配额口径只计 PDF blob (V1.5.28)');
  assert.deepEqual(Object.keys(row.data).sort(), ['aiChat', 'aiSummary', 'annotations', 'pages', 'stats', 'translatedPages']);
  // 3. 配额快照原地累加 (批量上传下一条预检依据)
  assert.equal(q.count, 1);
  assert.equal(q.bytes, REC.pdfBlob.size);
  assert.ok(q.ids.has('rec-1'));
});

test('cloudUploadRecord 预检拦截: 单 PDF 超 20MB 拒绝且零请求', async () => {
  login();
  const calls = installFetch([]);
  const big = { ...REC, pdfBlob: { size: 20 * 1024 * 1024 + 1, arrayBuffer: async () => { throw new Error('不应读取'); } } };
  const r = await cloudUploadRecord(big, VALID_SESSION);
  assert.equal(r.ok, false);
  assert.match(r.error, /单文件上限/);
  assert.equal(calls.length, 0, '超限应在发请求前拒绝');
});

test('cloudUploadRecord 预检拦截: 记录数达 30 条 / 体积将超 50MB', async () => {
  login();
  // 记录数满: 30 条已有 + 新 id → 拒绝, 仅发生配额查询 1 次
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: 'old-' + i, total_bytes: 1 }));
  let calls = installFetch(uploadRoutes(rows));
  let r = await cloudUploadRecord(REC, VALID_SESSION);
  assert.equal(r.ok, false);
  assert.match(r.error, /记录数已达上限/);
  assert.equal(calls.length, 1, '预检拒绝后不应上传');

  // 体积将超: 已占 49MB + 新 PDF 2MB > 50MB → 拒绝
  const bigBlob = new Blob([new Uint8Array(2 * 1024 * 1024)]);
  calls = installFetch(uploadRoutes([{ id: 'old-1', total_bytes: 49 * 1024 * 1024 }]));
  r = await cloudUploadRecord({ ...REC, pdfBlob: bigBlob }, VALID_SESSION);
  assert.equal(r.ok, false);
  assert.match(r.error, /存储将超上限/);
  assert.equal(calls.length, 1);
});

test('cloudUploadRecord 行写入失败(新记录): 清理孤儿 PDF + 返回配额可读错误', async () => {
  login();
  const calls = installFetch([
    quotaRoute([]),
    { match: u => u.includes('/storage/v1/object/history/'), respond: () => jsonResponse({ Key: 'k' }) },
    { match: u => u.includes('/rest/v1/history'), respond: () => jsonResponse({ message: 'QUOTA_RECORDS_EXCEEDED limit' }, 400) }
  ]);
  const r = await cloudUploadRecord(REC, VALID_SESSION);
  assert.equal(r.ok, false);
  assert.match(r.error, /记录数已达上限/);
  // 4 次请求 = 配额预检 + PDF 上传 + 行写入(失败) + 孤儿 PDF 清理 DELETE
  assert.equal(calls.length, 4);
  assert.equal(calls[3].opts.method, 'DELETE');
  assert.ok(calls[3].url.endsWith('/storage/v1/object/history/user-1/rec-1.pdf'));
});

test('cloudUploadRecord 行写入失败(覆盖已有记录): 不删 PDF, 防云端"有行无文件"', async () => {
  login();
  const q = { count: 1, bytes: 100, ids: new Set(['rec-1']) }; // rec-1 已在云端 → 覆盖
  const calls = installFetch([
    { match: u => u.includes('/storage/v1/object/history/'), respond: () => jsonResponse({ Key: 'k' }) },
    { match: u => u.includes('/rest/v1/history'), respond: () => jsonResponse({ message: 'boom' }, 500) }
  ]);
  const r = await cloudUploadRecord(REC, VALID_SESSION, q);
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 500/);
  assert.equal(calls.length, 2, '覆盖场景行失败后不应发孤儿清理 DELETE');
});

test('cloudListRecords: data->stats 列表查询与 snake→camel 字段映射', async () => {
  login();
  let capturedUrl = '';
  installFetch([
    {
      match: u => u.includes('/rest/v1/history'),
      respond: u => {
        capturedUrl = u;
        return jsonResponse([{
          id: 'r1', file_name: 'a.pdf', rec_time: '1700000000000', backend: 'baidu',
          src_label: '英语', tgt_label: '中文', page_count: 3, total_bytes: '1024',
          updated_at: '2024-01-01', stats: { localChars: 5, cloudChars: 2 }
        }]);
      }
    }
  ]);
  const r = await cloudListRecords();
  assert.equal(r.ok, true);
  // PostgREST 查询形态: 元数据列 + data->stats JSON 路径 + 按时间倒序 (V1.5.44)
  assert.ok(capturedUrl.includes('select=id,file_name,rec_time,backend,src_label,tgt_label,page_count,total_bytes,updated_at,data->stats'), capturedUrl);
  assert.ok(capturedUrl.includes('order=rec_time.desc'));
  assert.equal(r.list.length, 1);
  const it = r.list[0];
  assert.equal(it.fileName, 'a.pdf');
  assert.equal(it.time, 1700000000000);
  assert.equal(it.pageCount, 3);
  assert.equal(it.totalBytes, 1024);
  assert.deepEqual(it.stats, { localChars: 5, cloudChars: 2 });
});

test('cloudDownloadRecord: 云端记录不存在时的失败路径 (含 id URL 编码)', async () => {
  login();
  let capturedUrl = '';
  installFetch([
    {
      match: u => u.includes('/rest/v1/history'),
      respond: u => { capturedUrl = u; return jsonResponse([]); }
    }
  ]);
  const r = await cloudDownloadRecord('rec x&1');
  assert.equal(r.ok, false);
  assert.match(r.error, /云端记录不存在/);
  assert.ok(capturedUrl.includes('/rest/v1/history?id=eq.rec%20x%261'), capturedUrl);
});

test('cloudDeleteRecord: 表行 + 桶内 PDF 双删, PDF 删除失败可容忍', async () => {
  login();
  const calls = installFetch([
    { match: u => u.includes('/rest/v1/history'), respond: () => jsonResponse([]) },
    { match: u => u.includes('/storage/v1/object/history/'), respond: () => { throw new TypeError('Failed to fetch'); } }
  ]);
  const r = await cloudDeleteRecord('rec-1');
  assert.equal(r.ok, true, 'PDF 删除网络失败不应导致整体失败 (历史遗留缺 PDF 场景)');
  assert.equal(calls[0].opts.method, 'DELETE');
  assert.ok(calls[0].url.endsWith('/rest/v1/history?id=eq.rec-1'));
  assert.equal(calls[1].opts.method, 'DELETE');
  assert.ok(calls[1].url.endsWith('/storage/v1/object/history/user-1/rec-1.pdf'));
});

test('cloudQuotaUsage: 聚合占用 (条数/字节) 并回传上限', async () => {
  login();
  installFetch([quotaRoute([{ id: 'a', total_bytes: 1000 }, { id: 'b', total_bytes: 2048 }])]);
  const r = await cloudQuotaUsage();
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(r.bytes, 3048);
  assert.equal(r.maxRecords, 30);
  assert.equal(r.maxBytes, 50 * 1024 * 1024);
});

test('cloudClearAll: 删全部行(id=gt.防无过滤保护) → 列桶 → 批量删 PDF(prefixes body)', async () => {
  login();
  const calls = installFetch([
    { match: u => u.includes('/rest/v1/history?select'), respond: () => jsonResponse([{ id: 'r1', total_bytes: 1 }, { id: 'r2', total_bytes: 1 }]) },
    { match: u => u.endsWith('/rest/v1/history?id=gt.'), respond: () => jsonResponse([]) },
    { match: u => u.includes('/storage/v1/object/list/history'), respond: () => jsonResponse([{ name: 'r1.pdf' }, { name: 'r2.pdf' }]) },
    { match: u => u.endsWith('/storage/v1/object/history'), respond: () => jsonResponse([]) }
  ]);
  const r = await cloudClearAll();
  assert.equal(r.ok, true);
  assert.equal(r.deleted, 2);
  // 1. 行删除带 id=gt. 过滤 (PostgREST 无过滤删除保护)
  assert.equal(calls[1].opts.method, 'DELETE');
  assert.ok(calls[1].url.endsWith('/rest/v1/history?id=gt.'));
  // 2. 列桶按用户前缀
  assert.equal(calls[2].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[2].opts.body), { prefix: 'user-1/', limit: 100, offset: 0 });
  // 3. 批量删除 = DELETE /object/{bucket} + {prefixes} (V1.5.24 修复的规范形态)
  assert.equal(calls[3].opts.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[3].opts.body), { prefixes: ['user-1/r1.pdf', 'user-1/r2.pdf'] });
});

// ===== 桩: 内存 IndexedDB =====
// 下载/批量推拉的落库走 cache.js 真实 historyPut/historyAll (集成验证),
// 仅把 indexedDB 全局替换为内存实现 (open/upgradeneeded/transaction/put/getAll).
let idbMaps = null;
function ensureFakeIdb() {
  if (idbMaps) return idbMaps;
  const maps = new Map(); // storeName → Map(key → value)
  const keyPaths = new Map();
  const getMap = n => { if (!maps.has(n)) maps.set(n, new Map()); return maps.get(n); };
  const mkReq = result => {
    const r = { result: result, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => { if (r.onsuccess) r.onsuccess(); });
    return r;
  };
  const storeApi = n => ({
    put(v) { getMap(n).set(v[keyPaths.get(n) || 'id'], v); return mkReq(); },
    get(k) { return mkReq(getMap(n).get(k)); },
    getAll() { return mkReq(Array.from(getMap(n).values())); },
    delete(k) { getMap(n).delete(k); return mkReq(); },
    count() { return mkReq(getMap(n).size); },
    createIndex() { return {}; },
    index() { return { openCursor: () => mkReq() }; }
  });
  const db = {
    objectStoreNames: { contains: n => maps.has(n) },
    createObjectStore(n, opts) { keyPaths.set(n, (opts && opts.keyPath) || 'id'); getMap(n); return storeApi(n); },
    transaction(n) {
      const s = storeApi(n);
      const tx = { objectStore: () => s, error: null, oncomplete: null, onerror: null };
      queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
      return tx;
    }
  };
  globalThis.indexedDB = {
    open() {
      const req = { result: db, transaction: { objectStore: storeApi }, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  idbMaps = maps;
  return maps;
}

// 触发 cache.js openDB 建库, 返回 history store 的内存 Map (可预置/断言本地记录)
async function localHistory() {
  const maps = ensureFakeIdb();
  await historyAll();
  return maps.get('history');
}

// ===== 上传补充: 失败路径与预检容错 =====

test('cloudUploadRecord: PDF 上传网络失败 → 网络错误文案 (isNetworkError 识别 TypeError)', async () => {
  login();
  installFetch([
    quotaRoute([]),
    { match: u => u.includes('/storage/v1/object/history/'), respond: () => { throw new TypeError('Failed to fetch'); } }
  ]);
  const r = await cloudUploadRecord(REC, VALID_SESSION);
  assert.equal(r.ok, false);
  assert.match(r.error, /^网络错误：无法连接云端/);
});

test('cloudUploadRecord: PDF 上传 HTTP 失败 → 带状态码错误, 不再写行', async () => {
  login();
  const calls = installFetch([
    quotaRoute([]),
    { match: u => u.includes('/storage/v1/object/history/'), respond: () => jsonResponse({ error: 'boom' }, 500) },
    { match: u => u.includes('/rest/v1/history'), respond: () => jsonResponse({}) }
  ]);
  const r = await cloudUploadRecord(REC, VALID_SESSION);
  assert.equal(r.ok, false);
  assert.match(r.error, /PDF 上传失败 HTTP 500/);
  assert.equal(calls.length, 2, 'PDF 失败后不应写行记录');
});

test('cloudUploadRecord: 配额预检入网失败不阻塞上传 (quotaOf 抛错 → 放行为新记录)', async () => {
  login();
  const calls = installFetch([
    { match: u => u.includes('select=id,total_bytes'), respond: () => { throw new TypeError('Failed to fetch'); } },
    { match: u => u.includes('/storage/v1/object/history/'), respond: () => jsonResponse({ Key: 'k' }) },
    { match: u => u.includes('/rest/v1/history'), respond: () => jsonResponse({}) }
  ]);
  const r = await cloudUploadRecord(REC, VALID_SESSION);
  assert.equal(r.ok, true, '预检失败只影响友好提示, 服务端触发器兜底');
  assert.equal(calls.length, 3, '预检尝试 1 次 + PDF + 行');
});

test('cloudUploadRecord: 预检入网失败 + 行写入非配额失败 → 查行确认云端无此记录才清理孤儿 PDF (V1.5.55)', async () => {
  login();
  const calls = installFetch([
    { match: u => u.includes('select=id,total_bytes'), respond: () => { throw new TypeError('Failed to fetch'); } },
    { match: u => u.includes('/storage/v1/object/history/'), respond: () => jsonResponse({ Key: 'k' }) },
    { match: u => u.endsWith('/rest/v1/history'), respond: () => jsonResponse({ message: 'boom' }, 500) },
    { match: u => u.includes('/rest/v1/history?id=eq.rec-1'), respond: () => jsonResponse([]) }
  ]);
  const r = await cloudUploadRecord(REC, VALID_SESSION);
  assert.equal(r.ok, false);
  assert.match(r.error, /记录写入失败 HTTP 500/);
  // 5 次请求 = 预检(失败) + PDF 上传 + 行写入(失败) + 行存在性确认 + 孤儿 PDF 清理
  assert.equal(calls.length, 5);
  assert.ok(calls[3].url.includes('/rest/v1/history?id=eq.rec-1&select=id'), calls[3].url);
  assert.equal(calls[4].opts.method, 'DELETE');
  assert.ok(calls[4].url.endsWith('/storage/v1/object/history/user-1/rec-1.pdf'));
});

test('cloudUploadRecord: 预检入网失败 + 行写入失败但云端已有此记录 → 不删 PDF (防"有行无文件") (V1.5.55)', async () => {
  login();
  const calls = installFetch([
    { match: u => u.includes('select=id,total_bytes'), respond: () => { throw new TypeError('Failed to fetch'); } },
    { match: u => u.includes('/storage/v1/object/history/'), respond: () => jsonResponse({ Key: 'k' }) },
    { match: u => u.endsWith('/rest/v1/history'), respond: () => jsonResponse({ message: 'boom' }, 500) },
    { match: u => u.includes('/rest/v1/history?id=eq.rec-1'), respond: () => jsonResponse([{ id: 'rec-1' }]) }
  ]);
  const r = await cloudUploadRecord(REC, VALID_SESSION);
  assert.equal(r.ok, false);
  assert.match(r.error, /记录写入失败 HTTP 500/);
  assert.equal(calls.length, 4, '云端已有行, 孤儿清理前应查行确认且不发 DELETE');
});

test('cloudUploadRecord: 无 pdfBlob 的记录跳过 Storage 直写行 (V1.5.55)', async () => {
  login();
  const calls = installFetch(uploadRoutes([]));
  const r = await cloudUploadRecord({ ...REC, pdfBlob: null }, VALID_SESSION);
  assert.equal(r.ok, true, '此前 null pdfBlob 的 arrayBuffer() 抛错被误报为网络错误');
  assert.equal(calls.length, 2, '配额预检 + 行写入, 不发 Storage 请求');
  assert.ok(calls[1].url.endsWith('/rest/v1/history'));
  assert.equal(JSON.parse(calls[1].opts.body).total_bytes, 0);
});

// ===== 下载全链路 (含落库) =====

const PDF_BYTES = new TextEncoder().encode('%PDF-fake-download-body');
function pdfResponse() {
  return { ok: true, status: 200, json: async () => { throw new Error('no json'); }, text: async () => '', arrayBuffer: async () => PDF_BYTES.buffer };
}
const CLOUD_ROW = {
  id: 'rec-9', file_name: 'cloud.pdf', rec_time: '1700000000000', backend: 'volcengine',
  src_label: '英语', tgt_label: '中文', page_count: 5,
  data: { pages: ['p1'], translatedPages: ['t1'], stats: { localChars: 3 }, annotations: ['a1'] }
};

test('cloudDownloadRecord 全链路: 行+PDF 双取 → snake→camel 还原 → historyPut 落本地', async () => {
  login();
  const history = await localHistory();
  history.clear();
  const calls = installFetch([
    { match: u => u.includes('/rest/v1/history?id=eq.rec-9'), respond: () => jsonResponse([CLOUD_ROW]) },
    { match: u => u.includes('/storage/v1/object/history/user-1/rec-9.pdf'), respond: () => pdfResponse() }
  ]);
  const r = await cloudDownloadRecord('rec-9');
  assert.equal(r.ok, true);
  // 字段还原 (snake_case 行 → camelCase 本地记录, data jsonb 拆平)
  const rec = r.rec;
  assert.equal(rec.id, 'rec-9');
  assert.equal(rec.fileName, 'cloud.pdf');
  assert.equal(rec.time, 1700000000000);
  assert.equal(rec.backend, 'volcengine');
  assert.equal(rec.srcLabel, '英语');
  assert.equal(rec.tgtLabel, '中文');
  assert.equal(rec.pageCount, 5);
  assert.deepEqual(rec.pages, ['p1']);
  assert.deepEqual(rec.translatedPages, ['t1']);
  assert.deepEqual(rec.stats, { localChars: 3 });
  assert.deepEqual(rec.annotations, ['a1']);
  assert.equal(rec.aiSummary, null, '旧云端记录无 aiSummary 字段 → null 兜底 (V1.7.9)');
  assert.equal(rec.aiChat, null, '旧云端记录无 aiChat 字段 → null 兜底 (V1.7.12)');
  // PDF 原文件还原为 Blob
  assert.ok(rec.pdfBlob instanceof Blob);
  assert.equal(rec.pdfBlob.size, PDF_BYTES.length);
  assert.equal(rec.pdfBlob.type, 'application/pdf');
  // 已落本地 IndexedDB (真实 historyPut 链路)
  assert.equal(history.get('rec-9').fileName, 'cloud.pdf');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.headers['Authorization'], 'Bearer tok-abc');
});

test('cloudDownloadRecord: PDF 下载失败 → 失败返回且不落库', async () => {
  login();
  const history = await localHistory();
  history.clear();
  installFetch([
    { match: u => u.includes('/rest/v1/history?id=eq.rec-9'), respond: () => jsonResponse([CLOUD_ROW]) },
    { match: u => u.includes('/storage/v1/object/history/user-1/rec-9.pdf'), respond: () => jsonResponse({ error: 'not found' }, 404) }
  ]);
  const r = await cloudDownloadRecord('rec-9');
  assert.equal(r.ok, false);
  assert.match(r.error, /PDF 下载失败 HTTP 404/);
  assert.equal(history.size, 0, '失败不应落库');
});

// ===== 批量推拉 =====

function listRow(id, recTime) {
  return { id: id, file_name: id + '.pdf', rec_time: String(recTime), backend: '', src_label: '', tgt_label: '', page_count: 1, total_bytes: 1, updated_at: '', stats: null };
}

test('cloudPullMissing: 只拉本地缺失的记录, 失败逐条收集不中断', async () => {
  login();
  const history = await localHistory();
  history.clear();
  history.set('r2', { id: 'r2', time: 1, fileName: 'b.pdf' }); // 本地已有 → 跳过
  const row = id => ({
    id: id, file_name: id + '.pdf', rec_time: '5', backend: 'baidu', src_label: 's', tgt_label: 't',
    page_count: 1, data: { pages: [], translatedPages: [], stats: null, annotations: [] }
  });
  const calls = installFetch([
    { match: u => u.includes('select=id,file_name'), respond: () => jsonResponse([listRow('r1', 1), listRow('r2', 2), listRow('r3', 3)]) },
    { match: u => u.includes('/rest/v1/history?id=eq.r1'), respond: () => jsonResponse([row('r1')]) },
    { match: u => u.includes('/rest/v1/history?id=eq.r3'), respond: () => jsonResponse([row('r3')]) },
    { match: u => u.includes('/storage/v1/object/history/user-1/r1.pdf'), respond: () => pdfResponse() },
    { match: u => u.includes('/storage/v1/object/history/user-1/r3.pdf'), respond: () => jsonResponse({}, 404) }
  ]);
  const r = await cloudPullMissing();
  assert.equal(r.ok, true);
  assert.equal(r.downloaded, 1, 'r1 成功 / r2 本地已有跳过 / r3 PDF 失败');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /r3\.pdf: 云端拉取失败：PDF 下载失败 HTTP 404/);
  assert.ok(history.has('r1'), 'r1 应已落库');
  assert.equal(history.get('r2').fileName, 'b.pdf', 'r2 保持原样');
  assert.equal(history.has('r3'), false, 'r3 失败不应落库');
  assert.equal(calls.filter(c => c.url.includes('id=eq.')).length, 2, 'r2 不应发起下载请求');
});

test('cloudPushAll: 云端缺失或更旧才上传, 配额快照跨条复用只取一次', async () => {
  login();
  const history = await localHistory();
  history.clear();
  history.set('rec-a', { ...REC, id: 'rec-a', fileName: 'a.pdf', time: 200 }); // 云端更旧(100) → 上传
  history.set('rec-b', { ...REC, id: 'rec-b', fileName: 'b.pdf', time: 100 }); // 云端更新(300) → 跳过
  history.set('rec-c', { ...REC, id: 'rec-c', fileName: 'c.pdf', time: 300 }); // 云端缺失 → 上传
  let quotaFetches = 0;
  const calls = installFetch([
    { match: u => u.includes('select=id,file_name'), respond: () => jsonResponse([listRow('rec-a', 100), listRow('rec-b', 300)]) },
    { match: u => u.includes('select=id,total_bytes'), respond: () => { quotaFetches++; return jsonResponse([]); } },
    { match: u => u.includes('/storage/v1/object/history/'), respond: () => jsonResponse({ Key: 'k' }) },
    { match: u => u.endsWith('/rest/v1/history'), respond: () => jsonResponse({}) }
  ]);
  const r = await cloudPushAll();
  assert.equal(r.ok, true);
  assert.equal(r.uploaded, 2, 'rec-a 云端更旧 → 上传, rec-b 云端更新 → 跳过, rec-c 云端缺失 → 上传');
  assert.deepEqual(r.errors, []);
  assert.equal(quotaFetches, 1, '配额快照应只取一次并跨条复用');
  const uploadedIds = calls.filter(c => c.url.includes('/storage/v1/object/history/') && c.opts.method === 'POST')
    .map(c => c.url.split('/').pop().replace('.pdf', '')).sort();
  assert.deepEqual(uploadedIds, ['rec-a', 'rec-c']);
});

// ===== entitlement (V1.6.1 阶段1: 授权计费地基) =====
// 配额强制者 = 服务端触发器 (schema.sql 第 5 节套餐化); 此处验证客户端查询/缓存/兜底/联动。

test('getEntitlement: 未登录 → 免费档默认, 零网络', async () => {
  store.clear();
  const calls = installFetch([]);
  assert.deepEqual(await getEntitlement(), FREE_ENTITLEMENT);
  assert.equal(calls.length, 0);
});

test('getEntitlement: 登录且缓存未过期 → 命中 chrome.storage 缓存, 零网络', async () => {
  login();
  const calls = installFetch([]);
  const e = await getEntitlement();
  assert.equal(e.plan, 'free');
  assert.equal(e.maxRecords, 30);
  assert.equal(e.maxBytes, 50 * 1024 * 1024);
  assert.equal(calls.length, 0, 'TTL 内应命中缓存不发请求');
});

test('getEntitlement: 无缓存 → GET /functions/v1/entitlement (apikey + Bearer), 归一化并落缓存', async () => {
  login();
  store.delete('vtEntitlement');
  const calls = installFetch([
    { match: u => u.includes('/functions/v1/entitlement'), respond: () => jsonResponse({ plan: 'pro', expiresAt: '2027-01-01T00:00:00Z', maxRecords: 300, maxBytes: 209715200, proxyDailyLimit: 200000, proxyUsedChars: 5, aiDailyLimit: 100000, aiUsedChars: 1234 }) }
  ]);
  const e = await getEntitlement();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/functions/v1/entitlement'), calls[0].url);
  assert.equal(calls[0].opts.headers['apikey'], SUPABASE_ANON_KEY);
  assert.equal(calls[0].opts.headers['Authorization'], 'Bearer tok-abc');
  assert.equal(e.plan, 'pro');
  assert.equal(e.maxRecords, 300);
  assert.equal(e.maxBytes, 209715200);
  assert.equal(e.expiresAt, '2027-01-01T00:00:00Z');
  // 官方引擎 (V1.7.0) 与云端 AI (V1.7.10) 计量字段均归一化透传 (仅展示, 真实强制在服务端 RPC)
  assert.equal(e.proxyDailyLimit, 200000);
  assert.equal(e.proxyUsedChars, 5);
  assert.equal(e.aiDailyLimit, 100000);
  assert.equal(e.aiUsedChars, 1234);
  // 落缓存: 第二次调用零网络
  const calls2 = installFetch([]);
  assert.equal((await getEntitlement()).plan, 'pro');
  assert.equal(calls2.length, 0);
  await clearEntitlementCache();
});

test('getEntitlement: 服务端未回传 AI 用量字段 → 缺省回退 (100000/0, V1.7.10 向后兼容)', async () => {
  login();
  store.delete('vtEntitlement');
  const calls = installFetch([
    { match: u => u.includes('/functions/v1/entitlement'), respond: () => jsonResponse({ plan: 'pro', expiresAt: null, maxRecords: 300, maxBytes: 209715200 }) }
  ]);
  const e = await getEntitlement();
  assert.equal(calls.length, 1);
  assert.equal(e.aiDailyLimit, 20000, '老版本 entitlement Function 无 aiDailyLimit → 默认 2 万');
  assert.equal(e.aiUsedChars, 0, '无 aiUsedChars → 默认 0');
  await clearEntitlementCache();
});

test('getEntitlement: Function 不可达 → 免费档兜底不抛错; 同账户旧缓存 (哪怕过期) 优先', async () => {
  login();
  store.delete('vtEntitlement');
  const calls = installFetch([]); // 无匹配路由 → fetch 抛错
  assert.deepEqual(await getEntitlement(), FREE_ENTITLEMENT);
  assert.equal(calls.length, 1, '发起过一次请求');
  // 同账户旧缓存兜底: Pro 离线时预检不被误拦为 30 条
  store.set('vtEntitlement', {
    userId: VALID_SESSION.userId, fetchedAt: 1,
    value: { plan: 'pro', maxRecords: 300, maxBytes: 209715200, expiresAt: null }
  });
  installFetch([]);
  assert.equal((await getEntitlement()).plan, 'pro', '同账户旧缓存应兜底返回 pro');
  await clearEntitlementCache();
});

test('getEntitlement: 缓存属其他账户 → 忽略并重新请求 (换账号不串套餐)', async () => {
  login();
  store.set('vtEntitlement', {
    userId: 'other-user', fetchedAt: Date.now(),
    value: { plan: 'pro', maxRecords: 300, maxBytes: 209715200, expiresAt: null }
  });
  const calls = installFetch([
    { match: u => u.includes('/functions/v1/entitlement'), respond: () => jsonResponse({ plan: 'free', expiresAt: null, maxRecords: 30, maxBytes: 52428800 }) }
  ]);
  assert.equal((await getEntitlement()).plan, 'free', '他人缓存不应串号');
  assert.equal(calls.length, 1);
  await clearEntitlementCache();
});

test('cloudUploadRecord Pro 套餐: 免费 30 条上限不再拦截; 满套餐上限拦截且文案含 300', async () => {
  login();
  store.set('vtEntitlement', {
    userId: VALID_SESSION.userId, fetchedAt: Date.now(),
    value: { plan: 'pro', maxRecords: 300, maxBytes: 209715200, expiresAt: '2027-01-01T00:00:00Z' }
  });
  // 30 条 (免费档已满) + pro 套餐 → 放行
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: 'old-' + i, total_bytes: 1 }));
  const calls = installFetch(uploadRoutes(rows));
  let r = await cloudUploadRecord(REC, VALID_SESSION);
  assert.equal(r.ok, true, 'pro 套餐 30 条内不应拦截');
  assert.equal(calls.length, 3, '配额预检 + PDF 上传 + 行写入');
  // 300 条 (套餐上限已满) → 预检拦截, 文案含套餐值
  const rows300 = Array.from({ length: 300 }, (_, i) => ({ id: 'old-' + i, total_bytes: 1 }));
  const calls300 = installFetch(uploadRoutes(rows300));
  r = await cloudUploadRecord(REC, VALID_SESSION);
  assert.equal(r.ok, false);
  assert.match(r.error, /300 条/);
  assert.equal(calls300.length, 1, '预检拒绝后不应上传');
  await clearEntitlementCache();
});

test('entitlement 缓存 TTL = 3 分钟: 4 分钟前失效重查, 2 分钟内命中零网络 (V1.7.8)', async () => {
  login();
  const freeValue = { plan: 'free', maxRecords: 30, maxBytes: 52428800, expiresAt: null };
  // 4 分钟前: 超过 3 分钟 TTL → 重新查询 (服务端判 pro)
  store.set('vtEntitlement', { userId: VALID_SESSION.userId, fetchedAt: Date.now() - 4 * 60 * 1000, value: freeValue });
  const calls = installFetch([
    { match: u => u.includes('/functions/v1/entitlement'), respond: () => jsonResponse({ plan: 'pro', maxRecords: 300, maxBytes: 209715200, expiresAt: null }) }
  ]);
  const e = await getEntitlement();
  assert.equal(e.plan, 'pro', '过期缓存不应生效');
  assert.equal(calls.length, 1);
  // 2 分钟前: 仍在 TTL 内 → 命中本地缓存, 零网络
  store.set('vtEntitlement', { userId: VALID_SESSION.userId, fetchedAt: Date.now() - 2 * 60 * 1000, value: freeValue });
  const calls2 = installFetch([]);
  const e2 = await getEntitlement();
  assert.equal(e2.plan, 'free');
  assert.equal(calls2.length, 0, 'TTL 内应命中缓存');
  await clearEntitlementCache();
});

test('cloudQuotaUsage: Pro 套餐回传上限 300 条 / 200MB', async () => {
  login();
  store.set('vtEntitlement', {
    userId: VALID_SESSION.userId, fetchedAt: Date.now(),
    value: { plan: 'pro', maxRecords: 300, maxBytes: 209715200, expiresAt: null }
  });
  installFetch([quotaRoute([])]);
  const r = await cloudQuotaUsage();
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.equal(r.maxRecords, 300);
  assert.equal(r.maxBytes, 209715200);
  await clearEntitlementCache();
});
