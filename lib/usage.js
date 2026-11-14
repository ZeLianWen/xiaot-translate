/**
 * lib/usage.js — 本地用量统计 + 云端 AI 用量按天查询 (V1.7.14)
 *
 * 「历史用量」页的数据地基, 三路数据源:
 *   ① 文档翻译: 本地历史记录 (rec.time/rec.backend/rec.stats, V1.7.6 既有口径, 调用方聚合)
 *   ② BYOK 划词翻译: 本文件按天记 chrome.storage (vtLocalUsage) —— 划词不产生历史记录,
 *      background.js 翻译成功后 recordLocalUsage({ byok: { [backend]: chars } })
 *   ③ AI 分析: 本地模型 (自定义引擎) 按天记 vtLocalUsage { aiIn, aiOut };
 *      云端模型 (DeepSeek) 服务端 ai_usage 表 (chars/out_chars, 北京日期), 经 PostgREST
 *      RLS own-select 用自身令牌按天查询 (fetchCloudAiUsage), 无需新 Edge Function。
 *
 * 时间口径 (V1.7.19 统一): 服务端 ai_usage/translate_usage 的 day 为北京日期
 * (北京 0 点重置, schema (now() at time zone 'Asia/Shanghai')::date);
 * 本地记录用本地时区日期键 (dayKeyLocal)。中国时区 (UTC+8) 两者完全一致,
 * fetchCloudAiUsage 直接传本地日期串查询, 无需时区换算。本周 = 周一起 (中国习惯)。
 *
 * 存储结构 vtLocalUsage (chrome.storage.local, 按设备——本地调用不经过服务器):
 *   { v: 1, days: { '2026-10-22': { aiIn, aiOut, byok: { baidu, volcengine, tencent, custom, ... } } } }
 * 写入时裁剪超期天 (默认保留 45 天, 覆盖"本月"最长 31 天), 防无限膨胀。
 * 纯函数 (normalize/merge/prune/sum/rangeInfo) 与存储/网络分离, 可单测。
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-auth.js';

export const LOCAL_USAGE_KEY = 'vtLocalUsage';
export const LOCAL_USAGE_KEEP_DAYS = 45;// 本地时区日期键 'YYYY-MM-DD' (两位补零, 字典序 = 时间序, 供裁剪/比较)
export function dayKeyLocal(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function startOfDayMs(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const DAY_MS = 86400000;

// [fromTs, toTs] 闭区间内的本地日期键列表
function dayKeysBetween(fromTs, toTs) {
  const keys = [];
  for (let t = fromTs; t <= toTs; t += DAY_MS) keys.push(dayKeyLocal(t));
  return keys;
}

// 范围 → { from, to, days }: 今天 / 昨天 / 本周(周一起) / 本月 (本地时区, 纯函数)
export function rangeInfo(range, now) {
  const n = new Date(Number(now) || Date.now());
  const today0 = startOfDayMs(n);
  if (range === 'yesterday') {
    const from = today0 - DAY_MS;
    return { from: from, to: today0 - 1, days: [dayKeyLocal(from)] };
  }
  if (range === 'week') {
    const dow = (n.getDay() + 6) % 7; // 周一=0 … 周日=6
    const from = today0 - dow * DAY_MS;
    return { from: from, to: n.getTime(), days: dayKeysBetween(from, n.getTime()) };
  }
  if (range === 'month') {
    const from = new Date(n.getFullYear(), n.getMonth(), 1).getTime();
    return { from: from, to: n.getTime(), days: dayKeysBetween(from, n.getTime()) };
  }
  return { from: today0, to: n.getTime(), days: [dayKeyLocal(today0)] }; // today (默认)
}

// ===== 本地用量数据 (纯函数) =====

// 任意输入 → 规范结构 (非法/旧版数据兜底为空, 单字段非法按 0)
export function normalizeUsageData(data) {
  const src = data && typeof data === 'object' && data.days && typeof data.days === 'object' ? data.days : {};
  const days = {};
  for (const k of Object.keys(src)) {
    if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    const d = src[k];
    if (!d || typeof d !== 'object') continue;
    const byok = {};
    if (d.byok && typeof d.byok === 'object') {
      for (const bk of Object.keys(d.byok)) {
        const v = Number(d.byok[bk]);
        if (v > 0) byok[bk] = Math.floor(v);
      }
    }
    days[k] = {
      aiIn: Math.max(0, Math.floor(Number(d.aiIn) || 0)),
      aiOut: Math.max(0, Math.floor(Number(d.aiOut) || 0)),
      byok: byok
    };
  }
  return { v: 1, days: days };
}

// 增量合并一天: patch = { aiIn?, aiOut?, byok?: { [backend]: chars } } (不修改入参)
export function mergeUsageDay(data, dayKey, patch) {
  const d = normalizeUsageData(data);
  const day = Object.assign({ aiIn: 0, aiOut: 0, byok: {} }, d.days[dayKey] || {});
  if (patch && typeof patch === 'object') {
    if (Number(patch.aiIn) > 0) day.aiIn += Math.floor(Number(patch.aiIn));
    if (Number(patch.aiOut) > 0) day.aiOut += Math.floor(Number(patch.aiOut));
    if (patch.byok && typeof patch.byok === 'object') {
      for (const bk of Object.keys(patch.byok)) {
        const v = Number(patch.byok[bk]);
        if (v > 0) day.byok[bk] = (day.byok[bk] || 0) + Math.floor(v);
      }
    }
  }
  d.days[dayKey] = day;
  return d;
}

// 裁掉超期天 (保留最近 keepDays 天, 含今天; ISO 日期键字典序比较)
export function pruneUsageDays(data, now, keepDays) {
  const keep = Number(keepDays) || LOCAL_USAGE_KEEP_DAYS;
  const d = normalizeUsageData(data);
  const cutoff = dayKeyLocal(startOfDayMs(new Date(Number(now) || Date.now())) - (keep - 1) * DAY_MS);
  const days = {};
  for (const k of Object.keys(d.days)) {
    if (k >= cutoff) days[k] = d.days[k];
  }
  return { v: 1, days: days };
}

// 聚合若干天: { aiIn, aiOut, byok: { [backend]: chars } }
export function sumUsageDays(data, dayKeys) {
  const d = normalizeUsageData(data);
  const keys = new Set(Array.isArray(dayKeys) ? dayKeys : []);
  const out = { aiIn: 0, aiOut: 0, byok: {} };
  for (const k of Object.keys(d.days)) {
    if (!keys.has(k)) continue;
    const day = d.days[k];
    out.aiIn += day.aiIn;
    out.aiOut += day.aiOut;
    for (const bk of Object.keys(day.byok)) out.byok[bk] = (out.byok[bk] || 0) + day.byok[bk];
  }
  return out;
}

// ===== chrome.storage 读写 (薄封装, 失败静默不影响主流程) =====

async function readStoredUsage() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
  try {
    const items = await chrome.storage.local.get(LOCAL_USAGE_KEY);
    return items ? items[LOCAL_USAGE_KEY] : null;
  } catch (e) {
    return null;
  }
}

// 记一笔本地用量 (今天): background 划词 BYOK / doc-translate 本地模型 AI 对话
export async function recordLocalUsage(patch) {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
  try {
    const stored = await readStoredUsage();
    const merged = pruneUsageDays(mergeUsageDay(stored, dayKeyLocal(Date.now()), patch), Date.now());
    await chrome.storage.local.set({ [LOCAL_USAGE_KEY]: merged });
  } catch (e) {
    console.warn('[usage] 本地用量记录失败:', e);
  }
}

export async function readLocalUsage() {
  return normalizeUsageData(await readStoredUsage());
}

// ===== 云端 AI 用量查询 (PostgREST, RLS own-select, 无需新 Edge Function) =====

// 读 chrome.storage 原始会话 (不续期/不清会话, 纯读; 与 translator.js readRawSession 同款)
async function readRawSession() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
    const items = await chrome.storage.local.get('vtAuthSession');
    const s = items && items.vtAuthSession;
    return (s && s.accessToken && s.userId) ? s : null;
  } catch (e) {
    return null;
  }
}

// 云端 AI (DeepSeek) 按天查询: fromDay/toDay 为日期串 ('YYYY-MM-DD', V1.7.19 起直接传
// 本地日期键——服务端 day 已统一北京日期, 中国时区与本地日完全一致)。
// 返回 { ok, needLogin, inChars, outChars, rows }——rows 为按天明细 [{ day, inChars, outChars }]
// (V1.7.15 直方图数据源; day 与本地日键同字符串, 柱图按天对齐零偏差)。
// 未登录 needLogin=true, 查询失败 ok=false (调用方按 0 展示)。
export async function fetchCloudAiUsage(fromDay, toDay) {
  const s = await readRawSession();
  if (!s) return { ok: false, needLogin: true, inChars: 0, outChars: 0, rows: [] };
  const url = SUPABASE_URL.replace(/\/+$/, '') +
    '/rest/v1/ai_usage?select=day,chars,out_chars&day=gte.' + encodeURIComponent(String(fromDay)) +
    '&day=lte.' + encodeURIComponent(String(toDay)) + '&order=day';
  try {
    const resp = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + s.accessToken
      }
    });
    if (!resp.ok) return { ok: false, needLogin: false, inChars: 0, outChars: 0, rows: [] };
    const rows = await resp.json().catch(() => []);
    const outRows = [];
    let inChars = 0;
    let outChars = 0;
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const inC = Number(r && r.chars) || 0;
        const outC = Number(r && r.out_chars) || 0;
        inChars += inC;
        outChars += outC;
        outRows.push({ day: String(r && r.day || ''), inChars: inC, outChars: outC });
      }
    }
    return { ok: true, needLogin: false, inChars: inChars, outChars: outChars, rows: outRows };
  } catch (e) {
    return { ok: false, needLogin: false, inChars: 0, outChars: 0, rows: [] };
  }
}
