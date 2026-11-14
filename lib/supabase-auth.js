/**
 * Supabase 认证模块 (GoTrue REST API, 零依赖直调)
 * - 邮箱+密码 注册 / 登录 / 登出
 * - 会话持久化: chrome.storage.local 的 vtAuthSession (扩展各页面/后台均可读)
 * - access_token 临近过期时自动用 refresh_token 续期; 续期失败分类处理:
 *   服务端明确拒绝 (HTTP 400/401, 刷新令牌失效) 才清空会话;
 *   瞬时错误 (网络抖动/429/5xx) 保留会话本次返回 null, 避免"假登出"
 *
 * ===== 使用前配置 =====
 * 1. 在 https://supabase.com 创建项目 (免费档即可)
 * 2. 项目后台 Authentication → Providers → Email:
 *    - 关闭 "Confirm email" → 注册后即时登录 (推荐, 扩展场景无回跳页面)
 *    - 保持开启 → 注册后需到邮箱点验证链接才能登录 (本模块两种都兼容)
 * 3. Project Settings → API 复制 Project URL 与 API key 填入下方两个常量:
 *    - 新版密钥体系: Publishable key (sb_publishable_ 开头), 等同旧版 anon key
 *    - 旧版密钥体系: anon public (eyJhbGciOi... 开头), 两者任一均可
 *
 * 注: 该 key 是公开客户端标识 (数据安全靠 RLS 行级权限), 可硬编码进扩展, 不算泄密
 * 注: SUPABASE_URL 指向自有域名 (Cloudflare Worker 反代 supabase.co, 国内无需代理即可访问);
 *     Worker 下线时改回 Supabase 项目原始 URL (Project Settings → API 页可查, 需代理)
 */

export const SUPABASE_URL = 'https://sb.xiaoti.click';
export const SUPABASE_ANON_KEY = 'sb_publishable_PLAfFAkZRqoB1FpTWkGlsQ_FHc77Jyg';

const STORAGE_KEY = 'vtAuthSession';
const EXPIRY_MARGIN = 60; // access_token 过期前 60 秒内视为需续期

// ===== 基础请求 =====

function ensureConfig() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('尚未配置 Supabase：请在 lib/supabase-auth.js 顶部填入 Project URL 与 anon key');
  }
}

export function isSupabaseConfigured() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}

async function sbFetch(path, options) {
  ensureConfig();
  const opts = options || {};
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json'
  };
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  let resp;
  try {
    resp = await fetch(SUPABASE_URL.replace(/\/+$/, '') + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    throw new Error('网络错误：无法连接 Supabase（' + (e && e.message ? e.message : e) + '）');
  }
  // 204 (logout 成功) 等无内容响应
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = new Error(mapAuthError(resp.status, data));
    err.status = resp.status; // 供调用方区分瞬时错误与凭据失效 (如会话续期)
    throw err;
  }
  return data;
}

// 服务端错误 → 可读中文
function mapAuthError(status, data) {
  const d = data || {};
  const code = String(d.error_code || d.error || d.code || '');
  const desc = String(d.error_description || d.msg || d.message || '');
  const all = code + ' ' + desc;
  // 空格/下划线两种形态都匹配: 服务端 error_code 用下划线 (invalid_login_credentials),
  // msg/error_description 用空格 (Invalid login credentials) (V1.5.51 测试发现并修复)
  if (/invalid[ _]login[ _]credentials/i.test(all)) return '邮箱或密码错误';
  if (/already (been )?registered|user_already_exists|email_exists/i.test(all)) return '该邮箱已注册，请直接登录';
  if (/email[ _]not[ _]confirmed/i.test(all)) return '邮箱尚未验证：请先到注册邮箱点击验证链接';
  if (/signups[ _]not[ _]allowed/i.test(all)) return '该邮箱域名不允许注册';
  if (/at least|too short|should be at least/i.test(all) && /password/i.test(all)) return '密码强度不足（至少 6 位）';
  if (/same[ _]password|should be different from the old/i.test(all)) return '新密码不能与旧密码相同';
  if (/recent[ _]authentication[ _]required|should have been recently authenticated/i.test(all)) return '出于安全要求，请先退出登录并重新登录一次，再修改密码';
  if (/otp[ _]expired|token has expired|invalid otp/i.test(all)) return '验证码错误或已过期';
  if (status === 429) return '请求过于频繁，请稍后再试';
  if (status === 400) return desc || code || '请求参数错误';
  return desc || code || ('请求失败 (HTTP ' + status + ')');
}

// ===== 会话存取 =====

function normalizeSession(auth) {
  return {
    accessToken: auth.access_token,
    refreshToken: auth.refresh_token,
    expiresAt: auth.expires_at, // unix 秒
    userId: auth.user && auth.user.id ? auth.user.id : '',
    email: auth.user && auth.user.email ? auth.user.email : '',
    time: Date.now()
  };
}

async function getSession() {
  try {
    const r = await chrome.storage.local.get([STORAGE_KEY]);
    return r && r[STORAGE_KEY] ? r[STORAGE_KEY] : null;
  } catch (e) {
    return null;
  }
}

async function setSession(session) {
  try {
    if (session) await chrome.storage.local.set({ [STORAGE_KEY]: session });
    else await chrome.storage.local.remove(STORAGE_KEY);
  } catch (e) {
    console.warn('[AUTH] 会话写入失败:', e);
  }
}

// 取有效会话: 未过期直接返回; 临近过期自动续期; 续期失败(刷新令牌失效/被登出)清空会话
export async function getValidSession() {
  const s = await getSession();
  if (!s || !s.accessToken) return null;
  if (s.expiresAt && s.expiresAt - EXPIRY_MARGIN > Math.floor(Date.now() / 1000)) return s;
  return refreshSession(s);
}

// 进行中的续期请求 (并发调用复用同一 Promise, 防止同一 refresh_token 被并发使用)
let refreshInFlight = null;

async function refreshSession(s) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefreshSession(s);
  const done = () => { refreshInFlight = null; };
  refreshInFlight.then(done, done);
  return refreshInFlight;
}

async function doRefreshSession(s) {
  try {
    const data = await sbFetch('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: s.refreshToken }
    });
    const ns = normalizeSession(data);
    await setSession(ns);
    return ns;
  } catch (e) {
    // 仅服务端明确拒绝刷新令牌 (400/401) 才清空会话;
    // 网络抖动/429/5xx 等瞬时错误保留会话 (refresh_token 仍有效), 本次返回 null
    if (e && (e.status === 400 || e.status === 401)) {
      console.warn('[AUTH] 刷新令牌被服务端拒绝, 清除本地会话:', e.message);
      await setSession(null);
    } else {
      console.warn('[AUTH] 会话续期失败(瞬时错误, 保留本地会话):', e.message);
    }
    return null;
  }
}

// ===== 对外操作 =====

export function validateCredentials(email, password) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '邮箱格式不正确';
  if (String(password || '').length < 6) return '密码至少 6 位';
  return null;
}

// 注册: Supabase 关闭邮箱验证时返回 { needsConfirm: false, session } (自动登录);
// 开启邮箱验证时返回 { needsConfirm: true, session: null } (需到邮箱点验证链接)
export async function signUp(email, password) {
  const data = await sbFetch('/auth/v1/signup', {
    method: 'POST',
    body: { email: email, password: password }
  });
  if (data && data.access_token) {
    await setSession(normalizeSession(data));
    return { needsConfirm: false, session: await getSession() };
  }
  return { needsConfirm: true, session: null };
}

// 登录: 成功返回会话对象, 失败抛可读中文错误
export async function signIn(email, password) {
  const data = await sbFetch('/auth/v1/token?grant_type=password', {
    method: 'POST',
    body: { email: email, password: password }
  });
  if (!data || !data.access_token) throw new Error('登录失败：服务端未返回会话');
  await setSession(normalizeSession(data));
  return getSession();
}

// 登出: 服务端吊销刷新令牌 + 清空本地会话 (网络失败也保证本地登出)
export async function signOut() {
  const s = await getSession();
  if (s && s.accessToken) {
    try {
      await sbFetch('/auth/v1/logout', { method: 'POST', token: s.accessToken });
    } catch (e) {
      console.warn('[AUTH] 服务端登出失败(不影响本地登出):', e.message);
    }
  }
  await setSession(null);
}

// ===== 密码管理 (修改密码 / 忘记密码, V1.7.5) =====

// 修改密码 (已登录): PUT /auth/v1/user 携带当前会话令牌写入新密码
// 成功后当前会话不受影响, 旧密码立即失效
export async function updatePassword(newPassword) {
  if (String(newPassword || '').length < 6) throw new Error('新密码至少 6 位');
  const s = await getValidSession();
  if (!s) throw new Error('登录状态已失效，请重新登录后再修改密码');
  await sbFetch('/auth/v1/user', {
    method: 'PUT',
    token: s.accessToken,
    body: { password: newPassword }
  });
}

// 忘记密码第一步: 发送重置邮件 (POST /auth/v1/recover)
// ⚠️ 邮件形态取决于后台: 免费版 + Supabase 内置发信不允许改邮件模板, 默认只发「链接」;
//    配置自有 SMTP / Pro 后模板可加 {{ .Token }} 发「验证码」。扩展两条链路都支持 (V1.7.7):
//    - 链接形态: 用户复制邮件里的重置链接 → resetPasswordWithLink (token_hash 换会话)
//    - 验证码形态: resetPasswordWithCode (email + token)
// 未知邮箱同样返回 200 (GoTrue 防枚举), 客户端不区分
export async function requestPasswordReset(email) {
  const mail = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error('邮箱格式不正确');
  await sbFetch('/auth/v1/recover', {
    method: 'POST',
    body: { email: mail }
  });
}

// 解析忘记密码第二步的用户输入 (V1.7.7): 验证码 或 邮件里的重置链接
// 返回 { kind: 'code' | 'token_hash', value }; 无法识别返回 null
// 链接里的 token 实为 token_hash (邮件模板 {{ .TokenHash }}): verify 须走 token_hash 字段,
// 传 token 会被二次哈希 → otp_expired (V1.7.7 实测确认)
export function parseResetProof(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\d{6,8}$/.test(s)) return { kind: 'code', value: s };
  // 邮件 HTML 里参数分隔符常被转义成 &amp;: token 不在首位时会漏匹配, 先归一化
  const norm = s.replace(/&amp;/gi, '&');
  const m = norm.match(/[?#&](?:token_hash|token)=([A-Za-z0-9_\-]+)/);
  if (m) return { kind: 'token_hash', value: m[1] };
  // 只粘 token 本身: 56 位 hex (当前形态) 或 base64url 长串 (新旧版本兼容)
  if (/^[A-Za-z0-9_\-]{40,128}$/.test(s)) return { kind: 'token_hash', value: s };
  return null;
}

// 验证通过后的收尾: 会话落库 → 写入新密码 → 失败回滚半登录态 (保证"成功即已改密")
async function applyNewPassword(data, newPassword) {
  await setSession(normalizeSession(data));
  try {
    await sbFetch('/auth/v1/user', {
      method: 'PUT',
      token: data.access_token,
      body: { password: newPassword }
    });
  } catch (e) {
    await setSession(null); // 回滚半登录态: 未改成密码不算登录成功
    throw e;
  }
  return getSession();
}

// 忘记密码第二步 (验证码形态): verify(type=recovery, email+token) → 新密码 → 自动登录
export async function resetPasswordWithCode(email, code, newPassword) {
  const token = String(code || '').trim();
  const mail = String(email || '').trim();
  if (!/^\d{6,8}$/.test(token)) throw new Error('验证码格式不正确（应为 6~8 位数字）');
  if (String(newPassword || '').length < 6) throw new Error('新密码至少 6 位');
  const data = await sbFetch('/auth/v1/verify', {
    method: 'POST',
    body: { type: 'recovery', email: mail, token: token }
  });
  if (!data || !data.access_token) throw new Error('验证码校验失败：服务端未返回会话');
  return applyNewPassword(data, newPassword);
}

// 忘记密码第二步统一入口 (V1.7.7): 自动识别「验证码 / 重置链接」并分派到对应链路
// 分派逻辑放在 lib 而非 popup: 便于单测覆盖两条分支 (DOM 层按 V1.5.47 不单测)
export async function resetPasswordWithProof(proofInput, email, newPassword) {
  const proof = parseResetProof(proofInput);
  if (!proof) throw new Error('请粘贴邮件里的重置链接（也可输入邮件中的验证码）');
  return proof.kind === 'code'
    ? resetPasswordWithCode(email, proof.value, newPassword)
    : resetPasswordWithLink(proof.value, newPassword);
}

// 忘记密码第二步 (链接形态, V1.7.7): 从重置链接取 token_hash → 换会话 → 新密码 → 自动登录
// 适用于免费版默认发信 (邮件模板不可改, 只发链接); verify 不能带 email (GoTrue 仅接受 token_hash + type)
export async function resetPasswordWithLink(link, newPassword) {
  const p = parseResetProof(link);
  if (!p || p.kind !== 'token_hash') {
    throw new Error('链接无效：请粘贴邮件中「Reset password」按钮的完整链接');
  }
  if (String(newPassword || '').length < 6) throw new Error('新密码至少 6 位');
  let data = null;
  try {
    data = await sbFetch('/auth/v1/verify', {
      method: 'POST',
      body: { type: 'recovery', token_hash: p.value }
    });
  } catch (e) {
    // 链接一次性: 已使用/超过有效期 (默认 1 小时) 时给出针对性引导
    if (/验证码错误或已过期/.test(e.message)) throw new Error('重置链接无效或已过期，请重新发送重置邮件');
    throw e;
  }
  if (!data || !data.access_token) throw new Error('重置链接无效或已过期，请重新发送重置邮件');
  return applyNewPassword(data, newPassword);
}
