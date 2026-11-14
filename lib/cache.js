/**
 * 统一 IndexedDB 存储模块 (ES Module)
 * 供 background.js (划词翻译缓存) 和 doc-translate.js (历史记录+全文缓存) 共用
 * 设计说明书 2.2.3: 缓存复用系统, 粒度为"段落"哈希
 *
 * 段落缓存查询链 (V1.5.7): 本地 IndexedDB → 云端公共缓存池 (Supabase translation_cache,
 * 不区分用户) → 翻译引擎; 云端命中回填本地 (下次纯本地), 引擎结果双写本地+云端。
 * 云端译文以 enc1 密文存取 (V1.7.3 隐私收口, 见下文"云端密文"注释), 本地 IndexedDB 明文。
 *
 * DB version 3:
 *   - history: 翻译历史 (doc-translate 页面)
 *   - cache:   段落级翻译缓存 (key = backend|from|to|sha256(text)), time 索引供容量淘汰
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, getValidSession } from './supabase-auth.js';

const DB_NAME = 'vtDocTranslate';
const DB_VERSION = 3;
const HISTORY_STORE = 'history';
const CACHE_STORE = 'cache';
const HISTORY_LIMIT = 30; // 与云端配额 (CLOUD_QUOTA.maxRecords) 对齐
const CACHE_LIMIT = 20000; // 本地段落缓存条数上限 (~20-40MB)。分层设计: 本地只存热工作集 (近期文档),
                           // 未命中自动落云端公共池 (V1.5.40 定稿; 曾短暂上调 50000, 回归分层定位)

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          db.createObjectStore(HISTORY_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(CACHE_STORE)) {
          db.createObjectStore(CACHE_STORE, { keyPath: 'key' }).createIndex('by_time', 'time');
        } else {
          // 旧版本升级: 已存在的 cache store 补建 time 索引 (容量淘汰依赖)
          const store = req.transaction.objectStore(CACHE_STORE);
          if (!store.indexNames.contains('by_time')) store.createIndex('by_time', 'time');
          // 防御: 缺 time 字段的旧记录对 by_time 索引不可见, LRU 淘汰删不到它们;
          // 升级时补写 time=0 (视为最旧, 优先淘汰)
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const v = cursor.value;
            if (v && (typeof v.time !== 'number' || !isFinite(v.time))) {
              v.time = 0;
              cursor.update(v);
            }
            cursor.continue();
          };
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // 其他上下文升级 DB 版本时主动让出连接, 否则对方 open 永远 blocked
        db.onversionchange = () => {
          db.close();
          dbPromise = null; // 本连接已失效, 下次调用重新 open
        };
        resolve(db);
      };
      req.onerror = () => {
        // 失败的 Promise 不缓存: 临时错误 (配额/占用) 不应废掉整个页面生命周期 (V1.5.55)
        dbPromise = null;
        reject(req.error);
      };
      req.onblocked = () => {
        // 其他标签页持旧版本不放行: 明确失败优于永久挂起 (调用方有 catch 兜底)
        dbPromise = null;
        reject(new Error('IndexedDB 升级被其他标签页阻塞，请关闭其他小T翻译页面后重试'));
      };
    });
  }
  return dbPromise;
}

// ===== 历史记录 =====
export async function historyPut(rec) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    tx.objectStore(HISTORY_STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function historyAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(HISTORY_STORE, 'readonly').objectStore(HISTORY_STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.time - a.time));
    req.onerror = () => reject(req.error);
  });
}

export async function historyGet(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(HISTORY_STORE, 'readonly').objectStore(HISTORY_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function historyDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    tx.objectStore(HISTORY_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export { HISTORY_LIMIT, CACHE_LIMIT };

// ===== 段落级翻译缓存 =====
import { sha256Hex } from './translator.js';

function cacheKey(backend, from, to, text) {
  return `${backend}|${from}|${to}|${sha256Hex(text)}`;
}

// ===== 云端公共缓存池 (不区分用户, 匿名可读可写, 见 cloud/schema.sql 第 6 节) =====

// 熔断器: 连续失败 N 次后本会话停用云端缓存 (网络不佳时不拖慢每次未命中查询)
let cloudCacheFails = 0;
const CLOUD_CACHE_MAX_FAILS = 3;

function cloudCacheUrl(path) {
  return SUPABASE_URL.replace(/\/+$/, '') + path;
}

// ===== 云端密文 (V1.7.3): 译文明文整表可枚举的隐私收口 =====
// 威胁模型: tc_public_read 放行匿名无条件 SELECT, 任何拿到内嵌 anon key 的人可整表
// 拖走全部明文译文 (含用户私密 PDF 的段落)。加密后整表 dump 只见密文。
// 密钥由**原文**派生, 而非 cache key——key 列本身在表里, 用它派生等于没加密;
// 读方手里永远有原文 (查缓存就是为了译它), 解密零网络、微秒级; 没有原文解不开任何段落。
// 强度边界: 防"批量拖库"而非防"持有原文者" (他本就能自己翻译); 公开文本可被
// 字典还原 (本就公开)。AES-256-GCM (Web Crypto), 随机 nonce 12B + tag 16B。
// 存量明文行: 部署时一次性清池; 旧版扩展 (≤V1.7.2) 的明文写被 cache-put 拒收
// (400 → fire-and-forget 失败 → 熔断停贡献, 沿用 V1.6.0 阶段0 先例)。
const CLOUD_ENC_PREFIX = 'enc1:';
const CLOUD_ENC_PEPPER = 'xiaoti-cache-v1:';

function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000; // 分块避开 apply 参数上限 (大段译文)
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveCloudEncKey(text) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CLOUD_ENC_PEPPER + text));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// 云端写入前加密: 'enc1:' + base64(nonce 12B + 密文+tag)
async function encryptForCloud(text, translated) {
  const key = await deriveCloudEncKey(text);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(translated)));
  const both = new Uint8Array(12 + cipher.length);
  both.set(iv, 0);
  both.set(cipher, 12);
  return CLOUD_ENC_PREFIX + bytesToBase64(both);
}

// 云端命中后解密: 返回明文; 非 enc1 格式原样返回 (存量明文兼容);
// 解密失败 (无原文/密文损坏) 返回 null, 调用方视为未命中——比投毒行更健壮
async function decryptFromCloud(text, stored) {
  if (typeof stored !== 'string' || !stored.startsWith(CLOUD_ENC_PREFIX)) return stored;
  try {
    const bytes = base64ToBytes(stored.slice(CLOUD_ENC_PREFIX.length));
    if (bytes.length <= 12 + 16) return null;
    const key = await deriveCloudEncKey(text);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return new TextDecoder().decode(plain);
  } catch (e) {
    return null;
  }
}

// 云端查询: 命中返回明文译文, 未命中/失败/熔断中返回 null (4s 超时, 不阻塞太久)
async function cloudCacheGet(key, text) {
  if (cloudCacheFails >= CLOUD_CACHE_MAX_FAILS) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(cloudCacheUrl('/rest/v1/translation_cache?key=eq.' + encodeURIComponent(key) + '&select=translated'), {
      headers: { 'apikey': SUPABASE_ANON_KEY },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) { cloudCacheFails++; return null; }
    const rows = await resp.json();
    cloudCacheFails = 0;
    if (!rows || !rows.length) return null;
    // 解密 (V1.7.3): 失败视为未命中, 非网络故障不计熔断
    const plain = await decryptFromCloud(text, rows[0].translated || '');
    if (!plain) return null;
    // 命中热度统计 (fire-and-forget, 失败忽略)
    fetch(cloudCacheUrl('/rest/v1/rpc/bump_cache_hits'), {
      method: 'POST',
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ k: key })
    }).catch(() => {});
    return plain;
  } catch (e) {
    cloudCacheFails++;
    return null;
  }
}

// 云端写入 (V1.6.0 阶段0: 写入收口): 走 Edge Function cache-put——
// 匿名直写 /rest/v1/translation_cache 的 RLS 策略已回收 (防公共池投毒, 见 cloud/schema.sql 第 6 节),
// 服务端校验 key 格式/译文长度并按 IP 限流; time 由服务端赋值 (防伪造时间逃避容量淘汰)。
// V1.7.3: 译文经 encryptForCloud 加密后上送 (明文写被 cache-put 拒收)。
// V1.7.85: 服务端要求登录 + 账户/全局日配额, 无会话时直接放弃云端贡献 (本地写入不受影响)。
// fire-and-forget 不阻塞翻译流程, 失败由熔断器兜底 (累计 3 次本会话停用云端写)。
async function cloudCacheSet(key, backend, from, to, text, translated) {
  if (cloudCacheFails >= CLOUD_CACHE_MAX_FAILS) return;
  // 令牌取自已持久化会话 (临近过期会自动续期); 无登录/网络异常则跳过
  let session = null;
  try {
    session = await getValidSession();
  } catch (e) {
    session = null;
  }
  if (!session || !session.accessToken) return;
  let encValue;
  try {
    encValue = await encryptForCloud(text, translated);
  } catch (e) {
    return; // 加密失败静默放弃云端贡献, 不影响本地写入
  }
  try {
    const resp = await fetch(cloudCacheUrl('/functions/v1/cache-put'), {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.accessToken
      },
      body: JSON.stringify({ key: key, backend: backend, from_lang: from, to_lang: to, translated: encValue })
    });
    if (resp.ok) cloudCacheFails = 0; else cloudCacheFails++;
  } catch (e) {
    cloudCacheFails++;
  }
}
export { cloudCacheSet, cloudCacheGet, encryptForCloud, decryptFromCloud, CLOUD_ENC_PREFIX };

// ===== 本地段落缓存容量自治 =====
// 云端有 20 万行淘汰触发器, 本地此前无上限无限增长 (空间占用隐患)。
// 每 CACHE_EVERY_N 次写入检查一次条数, 超出 CACHE_LIMIT 按 time 升序游标删除最旧的溢出部分。
const CACHE_EVERY_N = 25; // 检查节流: 大文档逐段写入时不必每段都 count
let cacheWrites = 0;

function evictLocalCache() {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    const store = tx.objectStore(CACHE_STORE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const overflow = countReq.result - CACHE_LIMIT;
      if (overflow <= 0) { resolve(0); return; }
      let deleted = 0;
      const cursorReq = store.index('by_time').openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || deleted >= overflow) { resolve(deleted); return; }
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    countReq.onerror = () => reject(countReq.error);
    tx.onabort = () => reject(tx.error);
  }));
}

// 本地读取: 命中返回译文字符串, 未命中返回 null
function localCacheGet(key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.translated : null);
    req.onerror = () => reject(req.error);
  }));
}

// 本地写入
function localCacheSet(key, backend, from, to, text, translated) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    tx.objectStore(CACHE_STORE).put({
      key: key,
      backend: backend,
      from: from,
      to: to,
      source: text,
      translated: translated,
      time: Date.now()
    });
    tx.oncomplete = () => {
      resolve();
      // 写入后节流检查容量, 淘汰异步执行不阻塞翻译流程
      if (++cacheWrites >= CACHE_EVERY_N) {
        cacheWrites = 0;
        evictLocalCache().catch(() => {});
      }
    };
    tx.onerror = () => reject(tx.error);
  }));
}

// 查询链: 本地 → 云端 (命中回填本地) → null (调用方再走引擎)
// cacheGetEx 返回 { translated: 译文字符串|null, hit: 'local'|'cloud'|null } (V1.5.16, 供调用方区分命中来源)
// 自定义模型 (custom) 只走本地层 (V1.5.50): 云端读写双跳过——
// 写入会污染公共池 (模型质量参差不齐), 读取会命中他人模型、质量不可控的译文;
// 本地缓存只进自己的 IndexedDB 不影响他人, 且模型推理慢 (秒级/段), 复用收益大。
// 缓存键的引擎段含端点+模型名 (cacheBackendId, V1.5.50), 槽位间互不串
export async function cacheGetEx(backend, from, to, text) {
  const isCustom = backend === 'custom' || backend.startsWith('custom:');
  const key = cacheKey(backend, from, to, text);
  const local = await localCacheGet(key);
  if (local !== null && local !== '') return { translated: local, hit: 'local' };
  if (isCustom) return { translated: null, hit: null };
  const cloud = await cloudCacheGet(key, text);
  if (cloud) {
    // 回填本地: 下次命中纯本地 (~1ms), 云端只做首次未命中的兜底
    localCacheSet(key, backend, from, to, text, cloud).catch(() => {});
    return { translated: cloud, hit: 'cloud' };
  }
  return { translated: null, hit: null };
}

// 兼容包装: 只返回译文字符串 (划词翻译等无需区分命中来源)
export async function cacheGet(backend, from, to, text) {
  const r = await cacheGetEx(backend, from, to, text);
  return r.translated;
}

// 引擎翻译成功后写入: 本地必写 (await), 云端 fire-and-forget
// custom 引擎例外: 只写本地, 不进云端公共池 (V1.5.50, 理由见 cacheGetEx 注释)
export async function cacheSet(backend, from, to, text, translated) {
  const key = cacheKey(backend, from, to, text);
  await localCacheSet(key, backend, from, to, text, translated);
  if (backend === 'custom' || backend.startsWith('custom:')) return;
  cloudCacheSet(key, backend, from, to, text, translated);
}

// 清空段落翻译缓存, 返回删除条数
export async function cacheClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    const store = tx.objectStore(CACHE_STORE);
    const countReq = store.count();
    let count = 0;
    countReq.onsuccess = () => { count = countReq.result; };
    store.clear();
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error);
  });
}

// 列出全部段落缓存 (按写入时间新→旧, 供"历史缓存"面板展示)
export async function cacheAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.time - a.time));
    req.onerror = () => reject(req.error);
  });
}

// 删除单条段落缓存
export async function cacheDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    tx.objectStore(CACHE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 清空翻译历史, 返回删除条数
export async function historyClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    const store = tx.objectStore(HISTORY_STORE);
    const countReq = store.count();
    let count = 0;
    countReq.onsuccess = () => { count = countReq.result; };
    store.clear();
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error);
  });
}
