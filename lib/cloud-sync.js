/**
 * 云端同步模块 (Supabase REST + Storage, 零依赖)
 * 翻译历史漫游: 本地 IndexedDB 记录 ⇄ 云端 (history 表 + history 私有桶)
 *
 * 数据布局:
 *   - 表 history (RLS: user_id = auth.uid(), 用户只能读写自己的行):
 *       id/file_name/rec_time/backend/src_label/tgt_label/page_count 元数据
 *       data jsonb = { pages, translatedPages, stats, annotations }
 *   - 桶 history (私有, RLS 同样按用户目录隔离): {user_id}/{record_id}.pdf 放 PDF 原文件
 *
 * 通道: 全部走 SUPABASE_URL (sb.xiaoti.click 反代, 国内无代理可达);
 *       登录令牌来自 supabase-auth.js getValidSession() (自动续期)。
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, getValidSession } from './supabase-auth.js';
import { historyPut, historyAll } from './cache.js';
import { getEntitlement } from './entitlement.js';

function sbUrl(path) {
  return SUPABASE_URL.replace(/\/+$/, '') + path;
}

function authHeaders(session, extra) {
  const h = Object.assign({ 'apikey': SUPABASE_ANON_KEY }, extra || {});
  if (session) h['Authorization'] = 'Bearer ' + session.accessToken;
  return h;
}

// fetch 网络层失败 (断网/DNS/代理不可达) 抛 TypeError, 与 HTTP 4xx/5xx 区分, 给更友好的提示
function isNetworkError(e) {
  if (e instanceof TypeError) return true;
  return /failed to fetch|networkerror|load failed|network request failed/i.test((e && e.message) || '');
}

function netError(e) {
  return new Error('网络错误：无法连接云端（' + (e && e.message ? e.message : e) + '）');
}

// 未登录时统一返回 { ok:false, error:'未登录' }, 调用方据此提示
async function requireSession() {
  const s = await getValidSession();
  if (!s) return null;
  return s;
}

// ===== 每账户配额 =====
// 服务端由 history_quota_trigger 强制 (见 cloud/schema.sql 第 5 节);
// 客户端这层只是预检 + 友好提示, 拦不住的由服务端兜底 (HTTP 400)。
// V1.6.1 阶段1 配额套餐化: 实际上限按账户套餐 (getEntitlement, free 30条/50MB、
// pro 300条/200MB); 下述常量为免费档回退值, maxFileBytes 单文件上限不分套餐。
export const CLOUD_QUOTA = {
  maxRecords: 30,        // 免费档回退值 (与 entitlement.js FREE_ENTITLEMENT 一致)
  maxBytes: 50 * 1024 * 1024,   // 免费档回退值
  maxFileBytes: 20 * 1024 * 1024 // 单个 PDF 上限 20MB (不分套餐)
};

function mbOf(bytes) {
  return Math.round(bytes / (1024 * 1024));
}

function quotaErrMsg(text, ent) {
  if (text && text.indexOf('QUOTA_RECORDS_EXCEEDED') >= 0) return '云端记录数已达上限（' + ent.maxRecords + ' 条），请先删除部分云端记录';
  if (text && text.indexOf('QUOTA_BYTES_EXCEEDED') >= 0) return '云端存储已达上限（' + mbOf(ent.maxBytes) + 'MB），请先删除部分云端记录';
  return '';
}

// 查询当前账户配额占用 { count, bytes, ids:Set }
async function quotaOf(s) {
  const resp = await fetch(sbUrl('/rest/v1/history?select=id,total_bytes'), {
    headers: authHeaders(s)
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const rows = await resp.json();
  const q = { count: 0, bytes: 0, ids: new Set() };
  for (const r of (rows || [])) {
    q.count++;
    q.bytes += Number(r.total_bytes) || 0;
    q.ids.add(r.id);
  }
  return q;
}

export async function cloudQuotaUsage() {
  const s = await requireSession();
  if (!s) return { ok: false, error: '未登录' };
  try {
    const q = await quotaOf(s);
    const ent = await getEntitlement();
    return { ok: true, count: q.count, bytes: q.bytes, maxRecords: ent.maxRecords, maxBytes: ent.maxBytes };
  } catch (e) {
    return { ok: false, error: '配额查询失败：' + (e && e.message ? e.message : e) };
  }
}

// ===== 上传: 单条记录 (PDF → Storage, 元数据+数据 → 表 upsert) =====

export async function cloudUploadRecord(rec, session, quotaHint) {
  const s = session || await requireSession();
  if (!s) return { ok: false, error: '未登录' };
  const pdfSize = rec.pdfBlob ? rec.pdfBlob.size : 0;
  // 单文件上限
  if (pdfSize > CLOUD_QUOTA.maxFileBytes) {
    return { ok: false, error: 'PDF 超过单文件上限（20MB），未上传' };
  }
  try {
    // 0. 套餐配额 (阶段1: free/pro 上限不同) + 配额预检 (友好提示; 服务端触发器兜底)
    const ent = await getEntitlement();
    let q = quotaHint;
    if (!q) { try { q = await quotaOf(s); } catch (e) { q = null; } }
    const isNew = q ? !q.ids.has(rec.id) : true;
    if (q && isNew && q.count >= ent.maxRecords) {
      return { ok: false, error: '云端记录数已达上限（' + ent.maxRecords + ' 条），未上传' };
    }
    const data = {
      pages: rec.pages || [],
      translatedPages: rec.translatedPages || [],
      stats: rec.stats || null,
      annotations: rec.annotations || [],
      aiSummary: rec.aiSummary || null, // V1.7.9: AI 全文分析总结 (Pro 专享), 旧记录无此字段为 null
      aiChat: rec.aiChat || null // V1.7.12: AI 对话记录 (微信式聊天, 双引擎), 旧记录无此字段为 null
    };
    // 配额按"桶内 PDF 体积"计, 与访问端一致: 服务端 enforce_history_quota 只累加 storage.objects
    // 的 size (不含行内结构化数据)。此前客户端把 JSON 数据字节也算进 total_bytes, 导致面板显示
    // x/50MB 与服务端真实占用口径不一致 (V1.5.28 对齐)
    if (q && isNew && q.bytes + pdfSize > ent.maxBytes) {
      return { ok: false, error: '云端存储将超上限（' + mbOf(ent.maxBytes) + 'MB），未上传' };
    }
    // 1. PDF 原文件 → 私有桶 (x-upsert: 已存在则覆盖)
    // 无 pdfBlob 的记录跳过 Storage 上传仍写行 (V1.5.55: 此前无条件 arrayBuffer() 对
    // null 抛 TypeError, 被 isNetworkError 误报为"网络错误", 连元数据也传不上去)
    let resp;
    if (rec.pdfBlob) {
      const buf = await rec.pdfBlob.arrayBuffer();
      resp = await fetch(sbUrl('/storage/v1/object/history/' + encodeURIComponent(s.userId) + '/' + encodeURIComponent(rec.id) + '.pdf'), {
        method: 'POST',
        headers: authHeaders(s, { 'Content-Type': 'application/pdf', 'x-upsert': 'true' }),
        body: buf
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error('PDF 上传失败 HTTP ' + resp.status + ' ' + t.substring(0, 120));
      }
    }
    // 2. 行记录 upsert (Prefer: merge-duplicates, 同 id 覆盖)
    const row = {
      id: rec.id,
      file_name: rec.fileName || '未命名.pdf',
      rec_time: rec.time || Date.now(),
      backend: rec.backend || '',
      src_label: rec.srcLabel || '',
      tgt_label: rec.tgtLabel || '',
      page_count: rec.pageCount || 0,
      total_bytes: pdfSize,
      data: data
    };
    resp = await fetch(sbUrl('/rest/v1/history'), {
      method: 'POST',
      headers: authHeaders(s, { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify(row)
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      const qe = quotaErrMsg(t, ent);
      // 行写入失败 → 清理刚上传的孤儿 PDF。**只在新记录时清理**: 覆盖已有记录时 PDF 是
      // upsert 覆盖, 删掉会让云端"有行无文件"、历史永久打不开。配额拒绝必为新记录
      // (触发器对同 id 只跳条数检查, V1.5.55), 故 qe 命中时同样可安全清理 (V1.5.28 修复)
      let cleanOrphan = (q && isNew) || !!qe;
      if (!q && !cleanOrphan) {
        // 配额预检失败 (q=null) 无法判断新/旧记录: 查一次行, 确认云端原本无此记录才清理
        // (V1.5.55: 此前该路径不清理, 预检入网失败的瞬时错误会遗留孤儿 PDF 占配额)
        try {
          const chk = await fetch(sbUrl('/rest/v1/history?id=eq.' + encodeURIComponent(rec.id) + '&select=id'), {
            headers: authHeaders(s)
          });
          cleanOrphan = chk.ok ? ((await chk.json()) || []).length === 0 : false;
        } catch (_) { cleanOrphan = false; }
      }
      if (cleanOrphan && rec.pdfBlob) {
        await fetch(sbUrl('/storage/v1/object/history/' + encodeURIComponent(s.userId) + '/' + encodeURIComponent(rec.id) + '.pdf'), {
          method: 'DELETE',
          headers: authHeaders(s)
        }).catch(() => {});
      }
      if (qe) return { ok: false, error: qe };
      throw new Error('记录写入失败 HTTP ' + resp.status + ' ' + t.substring(0, 120));
    }
    // 3. 更新配额缓存 (批量上传时供下一条预检)
    if (q) {
      if (isNew) { q.count++; q.bytes += pdfSize; }
      q.ids.add(rec.id);
    }
    return { ok: true };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, error: netError(e).message };
    return { ok: false, error: '云端上传失败：' + (e && e.message ? e.message : e) };
  }
}

// ===== 云端列表 (仅元数据) =====

export async function cloudListRecords() {
  const s = await requireSession();
  if (!s) return { ok: false, error: '未登录' };
  try {
    // data->stats: JSON 路径只取 data jsonb 里的统计对象 (V1.5.44, 供命中来源饼图聚合; data 全量含译文太大, 列表不拉)
    const resp = await fetch(sbUrl('/rest/v1/history?select=id,file_name,rec_time,backend,src_label,tgt_label,page_count,total_bytes,updated_at,data->stats&order=rec_time.desc'), {
      headers: authHeaders(s)
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const rows = await resp.json();
    const list = (rows || []).map(r => ({
      id: r.id,
      fileName: r.file_name,
      time: Number(r.rec_time) || 0,
      backend: r.backend,
      srcLabel: r.src_label,
      tgtLabel: r.tgt_label,
      pageCount: r.page_count,
      totalBytes: Number(r.total_bytes) || 0,
      updatedAt: r.updated_at,
      stats: (r.stats && typeof r.stats === 'object') ? r.stats : null
    }));
    return { ok: true, list: list };
  } catch (e) {
    return { ok: false, error: '云端列表获取失败：' + (e && e.message ? e.message : e) };
  }
}

// ===== 拉取: 云端记录 → 本地 IndexedDB (已存在则覆盖) =====

export async function cloudDownloadRecord(id) {
  const s = await requireSession();
  if (!s) return { ok: false, error: '未登录' };
  try {
    // 1. 行记录
    let resp = await fetch(sbUrl('/rest/v1/history?id=eq.' + encodeURIComponent(id)), {
      headers: authHeaders(s)
    });
    if (!resp.ok) throw new Error('记录查询失败 HTTP ' + resp.status);
    const rows = await resp.json();
    if (!rows || !rows.length) return { ok: false, error: '云端记录不存在' };
    const row = rows[0];
    // 2. PDF 原文件
    resp = await fetch(sbUrl('/storage/v1/object/history/' + encodeURIComponent(s.userId) + '/' + encodeURIComponent(id) + '.pdf'), {
      headers: authHeaders(s)
    });
    if (!resp.ok) throw new Error('PDF 下载失败 HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    // 3. 还原为本地记录结构并落库
    const rec = {
      id: row.id,
      fileName: row.file_name,
      time: Number(row.rec_time) || 0,
      backend: row.backend,
      srcLabel: row.src_label,
      tgtLabel: row.tgt_label,
      pageCount: row.page_count,
      pdfBlob: new Blob([buf], { type: 'application/pdf' }),
      pages: (row.data && row.data.pages) || [],
      translatedPages: (row.data && row.data.translatedPages) || [],
      stats: (row.data && row.data.stats) || null,
      annotations: (row.data && row.data.annotations) || [],
      aiSummary: (row.data && row.data.aiSummary) || null, // V1.7.9: AI 全文分析总结, 旧云端记录无此字段为 null
      aiChat: (row.data && row.data.aiChat) || null // V1.7.12: AI 对话记录, 旧云端记录无此字段为 null
    };
    await historyPut(rec);
    return { ok: true, rec: rec };
  } catch (e) {
    return { ok: false, error: '云端拉取失败：' + (e && e.message ? e.message : e) };
  }
}

// ===== 删除云端记录 (表行 + 桶内 PDF) =====

export async function cloudDeleteRecord(id) {
  const s = await requireSession();
  if (!s) return { ok: false, error: '未登录' };
  try {
    let resp = await fetch(sbUrl('/rest/v1/history?id=eq.' + encodeURIComponent(id)), {
      method: 'DELETE',
      headers: authHeaders(s)
    });
    if (!resp.ok) throw new Error('记录删除失败 HTTP ' + resp.status);
    // PDF 不存在(历史遗留)时 404 静默忽略; 其他失败返回警告 (行已删, 不算失败,
    // 但桶内残留会占配额须让用户知晓; V1.5.55: 此前 403/500 也被 .catch 静默吞掉)
    let warning = '';
    try {
      const pd = await fetch(sbUrl('/storage/v1/object/history/' + encodeURIComponent(s.userId) + '/' + encodeURIComponent(id) + '.pdf'), {
        method: 'DELETE',
        headers: authHeaders(s)
      });
      if (!pd.ok && pd.status !== 404) warning = '云端 PDF 删除失败 (HTTP ' + pd.status + ')，可能仍占用存储配额';
    } catch (e) {
      warning = '云端 PDF 删除失败（网络），可能仍占用存储配额';
    }
    return warning ? { ok: true, warning: warning } : { ok: true };
  } catch (e) {
    return { ok: false, error: '云端删除失败：' + (e && e.message ? e.message : e) };
  }
}

// ===== 一键上传: 本地全部记录 → 云端 (云端缺失或更旧时上传) =====

export async function cloudPushAll() {
  let s = await requireSession();
  if (!s) return { ok: false, error: '未登录' };
  const cloud = await cloudListRecords();
  if (!cloud.ok) return cloud;
  const cloudMap = {};
  for (const c of cloud.list) cloudMap[c.id] = c.time;
  const local = await historyAll();
  let up = 0;
  let seq = 0;
  const errs = [];
  // 配额快照: 每条上传后原地累加, 供下一条预检 (服务端触发器兜底)
  let q = null;
  try { q = await quotaOf(s); } catch (e) { q = null; }
  for (const rec of local) {
    if (cloudMap[rec.id] !== undefined && cloudMap[rec.id] >= rec.time) continue; // 云端不比本地旧
    // 批量上传耗时长 (30 条 × 20MB 慢网), 周期性刷新会话防止 token 过期后剩余全部 401 (V1.5.55)
    if (++seq % 10 === 0) {
      const ns = await getValidSession();
      if (ns) s = ns;
    }
    const r = await cloudUploadRecord(rec, s, q);
    if (r.ok) up++; else errs.push(rec.fileName + ': ' + r.error);
  }
  return { ok: true, uploaded: up, errors: errs };
}

// ===== 一键拉取: 云端有而本地没有的记录 → 本地 =====

export async function cloudPullMissing() {
  const s = await requireSession();
  if (!s) return { ok: false, error: '未登录' };
  const cloud = await cloudListRecords();
  if (!cloud.ok) return cloud;
  const local = await historyAll();
  const localIds = {};
  for (const rec of local) localIds[rec.id] = true;
  let down = 0;
  const errs = [];
  for (const c of cloud.list) {
    if (localIds[c.id]) continue;
    const r = await cloudDownloadRecord(c.id);
    if (r.ok) down++; else errs.push(c.fileName + ': ' + r.error);
  }
  return { ok: true, downloaded: down, errors: errs };
}

// ===== 清空云端: 全部行 + 桶内全部 PDF (设置页"清除全部历史"联动用) =====

export async function cloudClearAll() {
  const s = await requireSession();
  if (!s) return { ok: false, error: '未登录' };
  try {
    // 1. 行数 (供返回值统计)
    const listR = await cloudListRecords();
    if (!listR.ok) return listR;
    const n = listR.list.length;
    // 2. 删全部行 (id=gt.'' 过滤掉 PostgREST 的无过滤删除保护, RLS 限定只能删到自己的行)
    let resp = await fetch(sbUrl('/rest/v1/history?id=gt.'), {
      method: 'DELETE',
      headers: authHeaders(s)
    });
    if (!resp.ok) throw new Error('行删除失败 HTTP ' + resp.status);
    // 3. 桶内对象: 列出后批量删
    // Storage 批量删除规范 = DELETE /object/{bucket} + body {prefixes:[...]}
    // (此前误用 POST + [{name}] 数组 body, 请求 404, 且未检查响应 → 行删了但 PDF 仍在,
    //  服务端按桶内对象体积算配额, 50MB 用量永不释放; V1.5.24 修复)
    const prefix = s.userId + '/';
    // 分页列举桶内对象 (V1.5.55: list 单次有上限, 孤儿对象超一页时须 offset 翻页,
    // 否则超出部分永远删不掉、50MB 配额不释放)
    const paths = [];
    const PAGE_SIZE = 100;
    let offset = 0;
    for (;;) {
      resp = await fetch(sbUrl('/storage/v1/object/list/history'), {
        method: 'POST',
        headers: authHeaders(s, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefix: prefix, limit: PAGE_SIZE, offset: offset })
      });
      if (!resp.ok) throw new Error('桶内对象列表失败 HTTP ' + resp.status);
      const objs = await resp.json().catch(() => []);
      if (!Array.isArray(objs) || !objs.length) break;
      for (const o of objs) paths.push(prefix + o.name);
      if (objs.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    if (paths.length) {
      resp = await fetch(sbUrl('/storage/v1/object/history'), {
        method: 'DELETE',
        headers: authHeaders(s, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefixes: paths })
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        throw new Error('桶内 PDF 删除失败 HTTP ' + resp.status + ' ' + t.substring(0, 120));
      }
    }
    return { ok: true, deleted: n };
  } catch (e) {
    return { ok: false, error: '云端清空失败：' + (e && e.message ? e.message : e) };
  }
}

