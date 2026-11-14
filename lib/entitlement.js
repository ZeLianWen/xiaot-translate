/**
 * 套餐权益查询 (V1.6.1 阶段1): Edge Function entitlement → 客户端配额
 *
 * 配额的强制者是服务端触发器 enforce_history_quota (cloud/schema.sql 第 5 节,
 * 按 entitlements 表套餐值拦截); 本模块供客户端预检 (cloud-sync.js) 与展示 (popup)。
 *
 * 查询结果短缓存于 chrome.storage.local (vtEntitlement, 10 分钟):
 *   - popup/预检高频读取, 避免每次都走网络;
 *   - 套餐变更 (发卡/降级) 客户端最迟 10 分钟生效; 服务端即时生效不受缓存影响;
 *   - 缓存绑定 userId, 换账号不串套餐;
 *   - Function 不可达时兜底免费档默认 (服务端触发器才是真正的强制者, 预检只是友好提示)。
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, getValidSession } from './supabase-auth.js';

// 免费档默认: 与服务端 free 常量一致 (schema.sql 第 5 节 / entitlement Function),
// 同时是 Function 不可达时的回退值
export const FREE_ENTITLEMENT = Object.freeze({
  plan: 'free',
  maxRecords: 30,
  maxBytes: 50 * 1024 * 1024,
  expiresAt: null
});

const CACHE_KEY = 'vtEntitlement';
const CACHE_TTL = 3 * 60 * 1000; // V1.7.8: 10 分钟 → 3 分钟 (降级后 UI 滞后最多 3 分钟; 服务端仍是唯一判定者)

function sbUrl(path) {
  return SUPABASE_URL.replace(/\/+$/, '') + path;
}

// 登出/切号时清套餐缓存 (防下一账户读到上一账户的套餐)
export async function clearEntitlementCache() {
  try {
    await chrome.storage.local.remove(CACHE_KEY);
  } catch (e) { /* chrome 不可用 (如 Node 测试环境) 时忽略 */ }
}

// 查询当前登录用户套餐 { plan, maxRecords, maxBytes, expiresAt }
// 永不抛错: 未登录/查询失败一律回落免费档默认
export async function getEntitlement(force) {
  const s = await getValidSession();
  if (!s) return FREE_ENTITLEMENT; // 未登录: 云端功能不可用, 零网络直接免费档
  try {
    if (!force) {
      const items = await chrome.storage.local.get(CACHE_KEY);
      const c = items && items[CACHE_KEY];
      // 缓存须未过期且属于当前账户 (换账号不串套餐)
      if (c && c.userId === s.userId && Date.now() - c.fetchedAt < CACHE_TTL) {
        return c.value;
      }
    }
    const resp = await fetch(sbUrl('/functions/v1/entitlement'), {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + s.accessToken }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const v = await resp.json();
    const value = {
      plan: v.plan === 'pro' ? 'pro' : 'free',
      maxRecords: Number(v.maxRecords) || FREE_ENTITLEMENT.maxRecords,
      maxBytes: Number(v.maxBytes) || FREE_ENTITLEMENT.maxBytes,
      expiresAt: v.expiresAt || null,
      // 官方引擎计量 (V1.7.0): 展示用 (真实强制在服务端 charge RPC); 缺省 0
      proxyDailyLimit: Number(v.proxyDailyLimit) || 50000,
      proxyUsedChars: Number(v.proxyUsedChars) || 0,
      // 云端 AI 分析计量 (V1.7.10): 展示用 (真实强制在服务端 ai_charge RPC); 缺省 0
      aiDailyLimit: Number(v.aiDailyLimit) || 20000,
      aiUsedChars: Number(v.aiUsedChars) || 0
    };
    try {
      await chrome.storage.local.set({ vtEntitlement: { userId: s.userId, fetchedAt: Date.now(), value: value } });
    } catch (e) { /* 缓存写失败不影响返回 */ }
    return value;
  } catch (e) {
    // 查询失败回退顺序: 同账户旧缓存 (哪怕已过期, Pro 离线时预检不被误拦为 30 条) → 免费档
    try {
      const items = await chrome.storage.local.get(CACHE_KEY);
      const c = items && items[CACHE_KEY];
      if (c && c.userId === s.userId && c.value) return c.value;
    } catch (e2) { /* 忽略 */ }
    return FREE_ENTITLEMENT; // 不抛错不阻断调用方
  }
}
