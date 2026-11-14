/**
 * test/usage.test.mjs — lib/usage.js 单元测试 (V1.7.14)
 *
 * 本地用量统计 (vtLocalUsage 按天记录: AI 本地模型输入/输出 + BYOK 划词翻译) 与
 * 「历史用量」页的范围/聚合纯函数 + 云端 ai_usage PostgREST 按天查询。
 * chrome.storage.local 用内存 Map 桩, fetch 用路由桩 (与 cloud.test.mjs 同款)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_USAGE_KEY,
  dayKeyLocal,
  rangeInfo,
  normalizeUsageData,
  mergeUsageDay,
  pruneUsageDays,
  sumUsageDays,
  recordLocalUsage,
  readLocalUsage,
  fetchCloudAiUsage
} from '../lib/usage.js';

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

// ===== 纯函数 =====

test('dayKeyLocal: 本地时区日期键两位补零', () => {
  assert.equal(dayKeyLocal(new Date(2026, 0, 5).getTime()), '2026-01-05');
  assert.equal(dayKeyLocal(new Date(2026, 9, 22, 23, 59, 59).getTime()), '2026-10-22');
});

test('rangeInfo: 今天 = 本地 0 点起, 单日键', () => {
  const now = new Date(2026, 9, 22, 15, 30).getTime();
  const ri = rangeInfo('today', now);
  assert.equal(ri.from, new Date(2026, 9, 22).getTime());
  assert.equal(ri.to, now);
  assert.deepEqual(ri.days, ['2026-10-22']);
});

test('rangeInfo: 昨天 = 昨日整天, to 为今日 0 点前一刻', () => {
  const now = new Date(2026, 9, 22, 8).getTime();
  const ri = rangeInfo('yesterday', now);
  assert.equal(ri.from, new Date(2026, 9, 21).getTime());
  assert.equal(ri.to, new Date(2026, 9, 22).getTime() - 1);
  assert.deepEqual(ri.days, ['2026-10-21']);
});

test('rangeInfo: 本周 = 周一起 (周日 10-25 → 周一 10-19 起, 7 天)', () => {
  const now = new Date(2026, 9, 25, 10).getTime(); // 2026-10-25 是周日
  const ri = rangeInfo('week', now);
  assert.equal(ri.from, new Date(2026, 9, 19).getTime());
  assert.equal(ri.days[0], '2026-10-19');
  assert.equal(ri.days.length, 7);
  assert.equal(ri.days[6], '2026-10-25');
});

test('rangeInfo: 周一当天 → 本周只含今天', () => {
  const now = new Date(2026, 9, 19, 9).getTime(); // 2026-10-19 是周一
  const ri = rangeInfo('week', now);
  assert.deepEqual(ri.days, ['2026-10-19']);
});

test('rangeInfo: 本月 = 1 日起逐日到今天', () => {
  const now = new Date(2026, 9, 22, 12).getTime();
  const ri = rangeInfo('month', now);
  assert.equal(ri.from, new Date(2026, 9, 1).getTime());
  assert.equal(ri.days.length, 22);
  assert.equal(ri.days[0], '2026-10-01');
  assert.equal(ri.days[21], '2026-10-22');
});

test('normalizeUsageData: 非法输入兜底空结构; 非法字段过滤', () => {
  assert.deepEqual(normalizeUsageData(null), { v: 1, days: {} });
  assert.deepEqual(normalizeUsageData('garbage'), { v: 1, days: {} });
  const n = normalizeUsageData({ days: {
    '2026-10-22': { aiIn: '5', aiOut: -3, byok: { baidu: '7', custom: -1, tencent: 2.9 } },
    'bad-key': { aiIn: 1 },
    '2026-10-21': 'not-object'
  } });
  assert.deepEqual(n.days['2026-10-22'], { aiIn: 5, aiOut: 0, byok: { baidu: 7, tencent: 2 } });
  assert.equal(n.days['bad-key'], undefined);
  assert.equal(n.days['2026-10-21'], undefined);
});

test('mergeUsageDay: 增量合并 aiIn/aiOut/byok, 不修改入参', () => {
  const base = { v: 1, days: { '2026-10-22': { aiIn: 10, aiOut: 5, byok: { baidu: 3 } } } };
  const merged = mergeUsageDay(base, '2026-10-22', { aiIn: 7, aiOut: 4, byok: { baidu: 2, custom: 9 } });
  assert.deepEqual(merged.days['2026-10-22'], { aiIn: 17, aiOut: 9, byok: { baidu: 5, custom: 9 } });
  assert.deepEqual(base.days['2026-10-22'], { aiIn: 10, aiOut: 5, byok: { baidu: 3 } }); // 入参不变
  // 负数/非法 patch 字段忽略
  const m2 = mergeUsageDay(merged, '2026-10-22', { aiIn: -5, aiOut: 'x', byok: { baidu: -1 } });
  assert.deepEqual(m2.days['2026-10-22'], merged.days['2026-10-22']);
});

test('pruneUsageDays: 超期天裁掉, 最近 keepDays 天保留', () => {
  const now = new Date(2026, 9, 22).getTime();
  const data = { v: 1, days: {
    '2026-08-01': { aiIn: 1, aiOut: 0, byok: {} },   // 82 天前, 裁掉
    '2026-09-10': { aiIn: 2, aiOut: 0, byok: {} },   // 42 天前, 保留 (45 天内)
    '2026-10-22': { aiIn: 3, aiOut: 0, byok: {} }
  } };
  const p = pruneUsageDays(data, now, 45);
  assert.equal(p.days['2026-08-01'], undefined);
  assert.ok(p.days['2026-09-10']);
  assert.ok(p.days['2026-10-22']);
});

test('sumUsageDays: 仅聚合指定天, ai 与 byok 各自累加', () => {
  const data = { v: 1, days: {
    '2026-10-20': { aiIn: 100, aiOut: 50, byok: { baidu: 10, custom: 5 } },
    '2026-10-21': { aiIn: 30, aiOut: 20, byok: { baidu: 7 } },
    '2026-10-22': { aiIn: 999, aiOut: 999, byok: { tencent: 999 } } // 不在聚合范围
  } };
  const s = sumUsageDays(data, ['2026-10-20', '2026-10-21']);
  assert.equal(s.aiIn, 130);
  assert.equal(s.aiOut, 70);
  assert.deepEqual(s.byok, { baidu: 17, custom: 5 });
});

// ===== chrome.storage 读写 =====

test('recordLocalUsage + readLocalUsage: 多笔合并到今天, 存储键 vtLocalUsage', async () => {
  store.clear();
  await recordLocalUsage({ aiIn: 120, aiOut: 80 });
  await recordLocalUsage({ byok: { volcengine: 42 } });
  const u = await readLocalUsage();
  const today = dayKeyLocal(Date.now());
  assert.equal(u.days[today].aiIn, 120);
  assert.equal(u.days[today].aiOut, 80);
  assert.deepEqual(u.days[today].byok, { volcengine: 42 });
  // 直读存储确认键名 (存的是规范结构)
  const raw = store.get(LOCAL_USAGE_KEY);
  assert.equal(raw.v, 1);
});

// ===== 云端 ai_usage PostgREST 查询 =====

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return handler(String(url), opts || {});
  };
  return calls;
}

test('fetchCloudAiUsage: 未登录 → needLogin 零网络', async () => {
  store.clear(); // 无 vtAuthSession
  const calls = installFetch(() => { throw new Error('不应发请求'); });
  const r = await fetchCloudAiUsage('2026-10-01', '2026-10-22');
  assert.deepEqual(r, { ok: false, needLogin: true, inChars: 0, outChars: 0, rows: [] });
  assert.equal(calls.length, 0);
});

test('fetchCloudAiUsage: 携带用户令牌按天查询, chars/out_chars 求和 + 按天明细 rows', async () => {
  store.set('vtAuthSession', { accessToken: 'tok-1', userId: 'u1' });
  const calls = installFetch(() => ({
    ok: true, status: 200,
    json: async () => [
      { day: '2026-10-20', chars: 1000, out_chars: 500 },
      { day: '2026-10-22', chars: 200, out_chars: 100 }
    ]
  }));
  const r = await fetchCloudAiUsage('2026-10-01', '2026-10-31');
  assert.equal(r.ok, true);
  assert.equal(r.needLogin, false);
  assert.equal(r.inChars, 1200);
  assert.equal(r.outChars, 600);
  assert.deepEqual(r.rows, [
    { day: '2026-10-20', inChars: 1000, outChars: 500 },
    { day: '2026-10-22', inChars: 200, outChars: 100 }
  ]);
  const u = new URL(calls[0].url.replace(/^https:\/\//, 'https://'));
  assert.ok(u.pathname.startsWith('/rest/v1/ai_usage'));
  assert.equal(u.searchParams.get('select'), 'day,chars,out_chars');
  assert.equal(u.searchParams.get('day'), 'gte.2026-10-01'); // PostgRange 语法: 同参数名两值
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok-1');
  assert.ok(calls[0].opts.headers.apikey);
});

test('fetchCloudAiUsage: 服务端错误/网络异常 → ok:false 按 0 展示', async () => {
  store.set('vtAuthSession', { accessToken: 'tok-1', userId: 'u1' });
  installFetch(() => ({ ok: false, status: 403, json: async () => ({}) }));
  let r = await fetchCloudAiUsage('2026-10-01', '2026-10-31');
  assert.equal(r.ok, false);
  assert.equal(r.inChars, 0);
  assert.deepEqual(r.rows, []);
  installFetch(() => { throw new Error('network down'); });
  r = await fetchCloudAiUsage('2026-10-01', '2026-10-31');
  assert.equal(r.ok, false);
  assert.equal(r.needLogin, false);
});
