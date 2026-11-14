// 统一设置 · 个人信息子页面 (V1.7.82): 与「模型配置」(options.html) 并列的独立子页面。
// 内容: 账户信息 (邮箱/用户ID/登录时间)、套餐与用量 (云端历史占用、官方引擎/AI 分析今日用量)、修改密码、退出登录。
// 未登录走 V1.7.81 注册/登录浮层 (auth-gate), 登录成功后重载页面继续。
import { getValidSession, signOut, updatePassword } from './lib/supabase-auth.js';
import { hasSession, mountAuthGate } from './lib/auth-gate.js';
import { getEntitlement, clearEntitlementCache } from './lib/entitlement.js';
import { cloudQuotaUsage } from './lib/cloud-sync.js';

const $ = id => document.getElementById(id);

const GATE_TITLE = '注册 / 登录后使用';
const GATE_DESC = '个人信息需邮箱登录后查看。登录后可管理账户、查看套餐与用量。';

function gate() {
  mountAuthGate({ title: GATE_TITLE, desc: GATE_DESC, onSuccess: () => location.reload() });
}

function setStatus(el, text, kind) {
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function setBadge(el, text, ok) {
  el.textContent = text;
  el.className = 'badge ' + (ok ? 'ok' : 'missing');
}

// ≥1 万字折算「X.X万」(与 popup renderPlan 同口径)
function fmtChars(n) {
  const v = Number(n) || 0;
  return v >= 10000 ? (v / 10000).toFixed(1) + '万' : String(v);
}

function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

// 官方引擎 / AI 分析今日用量: 优先服务端在响应里回传的实时值 (10 分钟缓存),
// 回退 entitlement 查询值 (与 popup readProxyUsage/readAiUsage 同口径, 仅展示不判定)
const USAGE_FRESH_MS = 10 * 60 * 1000;
async function readUsageCache(key) {
  try {
    const items = await chrome.storage.local.get(key);
    const u = items && items[key];
    return u && Date.now() - (Number(u.time) || 0) < USAGE_FRESH_MS ? u : null;
  } catch (_e) { return null; }
}

function renderAccount(session) {
  setBadge($('accBadge'), '已登录', true);
  $('accEmail').textContent = session.email || '—';
  $('accUserId').textContent = session.userId || '—';
  $('accLoginTime').textContent = session.time ? new Date(session.time).toLocaleString() : '—';
}

async function renderPlan() {
  const btn = $('planRefresh');
  btn.disabled = true;
  setBadge($('planBadge'), '查询中…', false);
  setStatus($('planStatus'), '');
  try {
    const [ent, proxyUsage, aiUsage] = await Promise.all([
      getEntitlement(true), // 刷新按钮跳过 3 分钟缓存强制重查
      readUsageCache('vtProxyUsage'),
      readUsageCache('vtAiUsage')
    ]);
    if (!ent) return;
    const isPro = ent.plan === 'pro';
    setBadge($('planBadge'), isPro ? 'Pro' : '免费版', isPro);
    $('planName').textContent = isPro ? 'Pro 套餐' : '免费版';
    $('planExpires').textContent = isPro
      ? (ent.expiresAt ? new Date(ent.expiresAt).toLocaleDateString() + ' 到期' : '长期有效')
      : '—';
    const proxyUsed = Number(proxyUsage ? proxyUsage.usedChars : ent.proxyUsedChars) || 0;
    const proxyLimit = Number(proxyUsage ? proxyUsage.dailyLimit : ent.proxyDailyLimit) || 50000;
    $('planProxyUsage').textContent = fmtChars(proxyUsed) + ' / ' + fmtChars(proxyLimit) + ' 字';
    const aiUsed = Number(aiUsage ? aiUsage.usedChars : ent.aiUsedChars) || 0;
    const aiLimit = Number(aiUsage ? aiUsage.dailyLimit : ent.aiDailyLimit) || 20000;
    $('planAiUsage').textContent = fmtChars(aiUsed) + ' / ' + fmtChars(aiLimit) + ' 字';
    // 云端历史占用: count/bytes 来自 history 表实时查询, 上限来自套餐
    $('planCloudQuota').textContent = '查询中…';
    const q = await cloudQuotaUsage();
    if (q && q.ok) {
      $('planCloudQuota').textContent = q.count + ' / ' + ent.maxRecords + ' 条 · '
        + fmtBytes(q.bytes) + ' / ' + Math.round(ent.maxBytes / (1024 * 1024)) + ' MB';
      setStatus($('planStatus'), '已刷新 ' + new Date().toLocaleTimeString(), 'ok');
    } else {
      $('planCloudQuota').textContent = '查询失败';
      setStatus($('planStatus'), (q && q.error) ? q.error : '云端配额查询失败', 'err');
    }
  } catch (e) {
    setStatus($('planStatus'), (e && e.message) ? e.message : String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

// 退出登录: 服务端吊销刷新令牌 + 本地清理 (套餐/用量缓存随会话清除, 防换账号读到上一账户数据)
async function doSignOut() {
  const btn = $('accSignOut');
  btn.disabled = true;
  try {
    try { await signOut(); } catch (_e) { /* 网络失败也保证本地登出 */ }
    await clearEntitlementCache();
    try { await chrome.storage.local.remove('vtProxyUsage'); } catch (_e) { /* 用量展示缓存, 清理失败无影响 */ }
    try { await chrome.storage.local.remove('vtAiUsage'); } catch (_e) { /* 用量展示缓存, 清理失败无影响 */ }
  } finally {
    btn.disabled = false;
  }
  setStatus($('accStatus'), '已退出登录', 'ok');
  gate(); // 退出后回到注册/登录浮层
}

async function doChangePassword() {
  const st = $('pwdStatus');
  const p1 = $('pwdNew').value;
  const p2 = $('pwdNew2').value;
  if (String(p1).length < 6) return setStatus(st, '新密码至少 6 位', 'err');
  if (p1 !== p2) return setStatus(st, '两次输入的新密码不一致', 'err');
  const btn = $('pwdSave');
  btn.disabled = true;
  setStatus(st, '修改中…');
  try {
    await updatePassword(p1);
    $('pwdNew').value = '';
    $('pwdNew2').value = '';
    setStatus(st, '密码修改成功，旧密码已失效', 'ok');
  } catch (e) {
    setStatus(st, (e && e.message) ? e.message : String(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

$('accSignOut').addEventListener('click', doSignOut);
$('planRefresh').addEventListener('click', renderPlan);
$('pwdSave').addEventListener('click', doChangePassword);

async function init() {
  // 强制登录门禁 (V1.7.81): 个人信息页属于注册用户功能
  if (!(await hasSession())) {
    gate();
    return;
  }
  // hasSession 为 true 但续期瞬时失败 (getValidSession 返回 null) 时同样按未登录处理
  const session = await getValidSession();
  if (!session) {
    gate();
    return;
  }
  renderAccount(session);
  renderPlan();
}
init();
