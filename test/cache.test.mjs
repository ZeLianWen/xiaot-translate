/**
 * lib/cache.js 缓存分层测试 (V1.5.50)
 * 运行: node --test test/
 * custom 引擎只走本地层 (云端读写双跳过): 读/写都会尝试本地 IndexedDB,
 * Node 环境无 indexedDB 即抛错——抛错本身证明进入了本地路径 (而非 V1.5.48 的静默全跳过)。
 * 云端层跳过无法在 Node 验证 (需 fetch 打桩拦截不到=未发起), 由分层逻辑保证。
 *
 * V1.6.0 增补: 云端写入收口 (cloudCacheSet) 请求形态/令牌附带/熔断验证——
 * 云写改走 Edge Function /functions/v1/cache-put (匿名直写 RLS 已回收), time 由服务端赋值。
 *
 * V1.7.3 增补: 云端密文 (enc1) —— encryptForCloud/decryptFromCloud 往返、
 * 原文派生密钥 (错原文解不开)、存量明文兼容、cloudCacheSet 上送密文、
 * cloudCacheGet 命中解密/解密失败视为未命中。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheGetEx, cacheSet, cloudCacheSet, cloudCacheGet,
  encryptForCloud, decryptFromCloud, CLOUD_ENC_PREFIX
} from '../lib/cache.js';
import { cacheBackendId } from '../lib/translator.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../lib/supabase-auth.js';

// ===== 桩: chrome.storage.local (内存 Map, cloudCacheSet 读 vtAuthSession 用) =====
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
      async set(obj) { for (const k of Object.keys(obj)) store.set(k, obj[k]); }
    }
  }
};

// ===== 桩: fetch =====
function installFetch(respond) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return respond(String(url), opts || {}, calls.length);
  };
  return calls;
}

test('custom 引擎读取缓存: 走本地层 (Node 下抛 indexedDB 未定义即证明未全跳过)', async () => {
  await assert.rejects(
    () => cacheGetEx('custom', 'en', 'zh-CN', 'hello world'),
    /indexedDB/,
    'custom 应进入本地 IndexedDB 查询路径'
  );
  await assert.rejects(
    () => cacheGetEx('custom:https://api.x.com/v1|deepseek-r1', 'en', 'zh-CN', 'hello world'),
    /indexedDB/,
    '带模型标识的 custom 键也应进入本地查询路径'
  );
});

test('custom 引擎写入缓存: 走本地层 (同上, 抛错即证明进入了写入路径)', async () => {
  await assert.rejects(
    () => cacheSet('custom:https://api.x.com/v1|deepseek-r1', 'en', 'zh-CN', 'hello world', '你好世界'),
    /indexedDB/,
    'custom 写入应进入本地 IndexedDB 写入路径'
  );
});

test('短路仅限 custom: 其他 backend 的读取同样走本地层', async () => {
  await assert.rejects(
    () => cacheGetEx('baidu', 'en', 'zh-CN', 'hello'),
    /indexedDB/,
    '非 custom 引擎应进入本地 IndexedDB 查询路径'
  );
});

test('cacheBackendId: 非 custom 原样透传', () => {
  assert.equal(cacheBackendId('baidu', {}), 'baidu');
  assert.equal(cacheBackendId('volcengine', { customModels: [{ baseUrl: 'https://x' }] }), 'volcengine');
});

test('cacheBackendId: custom 展开为 端点|模型, 含槽位切换与旧扁平字段回退', () => {
  // 新结构: 跟随 customActive 槽位
  const config = {
    customActive: 1,
    customModels: [
      { baseUrl: 'https://api.a.com/v1/', apiKey: 'k', model: 'model-a', maxBytes: 4000 },
      { baseUrl: 'https://api.b.com/v1', apiKey: 'k', model: 'model-b', maxBytes: 4000 },
      { baseUrl: 'https://api.c.com/v1', apiKey: 'k', model: 'model-c', maxBytes: 4000 }
    ]
  };
  assert.equal(cacheBackendId('custom', config), 'custom:https://api.b.com/v1|model-b');
  config.customActive = 0;
  // 尾斜杠归一: 'https://api.a.com/v1/' → 'https://api.a.com/v1'
  assert.equal(cacheBackendId('custom', config), 'custom:https://api.a.com/v1|model-a');
  // 旧扁平字段回退 + 尾斜杠归一 + 空模型回退默认名
  assert.equal(
    cacheBackendId('custom', { customBaseUrl: 'https://old.com/v1//', customModel: '' }),
    'custom:https://old.com/v1|gpt-3.5-turbo'
  );
  // 不同模型 ⇒ 不同缓存键 (槽位间互不串的核心保证)
  const idA = cacheBackendId('custom', { ...config, customActive: 0 });
  const idB = cacheBackendId('custom', { ...config, customActive: 2 });
  assert.notEqual(idA, idB);
});

// ===== V1.6.0 云端写入收口: cloudCacheSet 走 Edge Function =====
// V1.7.3: translated 改为 enc1 密文 (cache-put 拒收明文)

test('cloudCacheSet 未登录: 不发请求 (V1.7.85 服务端要求登录, 本地写入不受影响)', async () => {
  store.clear();
  const calls = installFetch(() => ({ ok: true }));
  await cloudCacheSet('baidu|en|zh-CN|' + 'a'.repeat(64), 'baidu', 'en', 'zh-CN', 'hello cloud', '你好，云端');
  assert.equal(calls.length, 0, '无会话时不应发起云端写请求');
});

test('cloudCacheSet 已登录: 携带 Bearer 令牌, 体恰好五项且 translated 为 enc1 密文', async () => {
  store.set('vtAuthSession', {
    accessToken: 'tok-1', refreshToken: 'r1', userId: 'u1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600
  });
  const calls = installFetch(() => ({ ok: true }));
  const text = 'hello';
  await cloudCacheSet('baidu|en|zh-CN|' + 'b'.repeat(64), 'baidu', 'en', 'zh-CN', text, '你好');
  try {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, SUPABASE_URL + '/functions/v1/cache-put');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['apikey'], SUPABASE_ANON_KEY);
    assert.equal(calls[0].opts.headers['Authorization'], 'Bearer tok-1');
    const body = JSON.parse(calls[0].opts.body);
    assert.deepEqual(
      Object.keys(body).sort(),
      ['backend', 'from_lang', 'key', 'to_lang', 'translated'],
      '体字段恰好五项'
    );
    assert.equal(body.backend, 'baidu');
    assert.equal(body.from_lang, 'en');
    assert.equal(body.to_lang, 'zh-CN');
    assert.ok(body.translated.startsWith(CLOUD_ENC_PREFIX), '上送值应为 enc1 密文');
    assert.notEqual(body.translated, '你好', '明文不应直接上送');
    assert.equal(await decryptFromCloud(text, body.translated), '你好', '密文可由原文解回');
    assert.equal('time' in body, false, 'time 由服务端赋值 (防伪造时间逃避 LRU 淘汰)');
  } finally {
    store.clear();
  }
});

// ===== V1.7.3 云端密文 (enc1) =====

test('encryptForCloud/decryptFromCloud 往返: 中英日+emoji, 随机 nonce 两次密文不同', async () => {
  const samples = ['你好，世界', 'Hello world', 'こんにちは世界', '翻译🚀✅测试', 'a'.repeat(5000)];
  for (const s of samples) {
    const enc = await encryptForCloud('原文' + s, s);
    assert.ok(enc.startsWith(CLOUD_ENC_PREFIX), 'enc1 前缀');
    assert.equal(await decryptFromCloud('原文' + s, enc), s, '解密应还原明文');
  }
  const enc1 = await encryptForCloud('same text', '同一译文');
  const enc2 = await encryptForCloud('same text', '同一译文');
  assert.notEqual(enc1, enc2, '随机 nonce: 两次加密产出应不同');
  assert.equal(await decryptFromCloud('same text', enc2), '同一译文');
});

test('密钥由原文派生: 错原文解不开 (null), 对的原文可解', async () => {
  const enc = await encryptForCloud('correct original', '正确译文');
  assert.equal(await decryptFromCloud('wrong original', enc), null, '错原文应解密失败返回 null');
  assert.equal(await decryptFromCloud('correct original', enc), '正确译文');
});

test('存量明文兼容: 非 enc1 前缀原样返回 (不清池窗口期的旧行)', async () => {
  assert.equal(await decryptFromCloud('any text', '旧版明文译文'), '旧版明文译文');
  assert.equal(await decryptFromCloud('any text', ''), '');
});

test('cloudCacheGet 命中: enc1 密文行解密返回明文, 附加 bump_cache_hits 热度请求', async () => {
  const key = 'baidu|en|zh-CN|' + 'e'.repeat(64);
  const text = 'cloud hit text';
  const enc = await encryptForCloud(text, '云端命中译文');
  const calls = installFetch((url) => {
    if (url.includes('/rest/v1/translation_cache')) {
      return { ok: true, json: async () => ([{ translated: enc }]) };
    }
    return { ok: true };
  });
  const got = await cloudCacheGet(key, text);
  assert.equal(got, '云端命中译文', '命中行应解密为明文');
  assert.equal(calls.length, 2, '查询 + bump 两次请求');
  assert.ok(calls[0].url.includes('/rest/v1/translation_cache?key=eq.'), '首次为缓存查询');
  assert.ok(calls[1].url.includes('/rest/v1/rpc/bump_cache_hits'), '命中后 fire-and-forget 热度统计');
});

test('cloudCacheGet 解密失败 (错原文/密文损坏): 视为未命中, 不计熔断、不 bump', async () => {
  const key = 'baidu|en|zh-CN|' + 'f'.repeat(64);
  const enc = await encryptForCloud('real original', '真实译文');
  const calls = installFetch((url) => {
    if (url.includes('/rest/v1/translation_cache')) {
      return { ok: true, json: async () => ([{ translated: enc }]) };
    }
    return { ok: true };
  });
  const got = await cloudCacheGet(key, 'mismatched original');
  assert.equal(got, null, '错原文解密失败应视为未命中');
  assert.equal(calls.length, 1, '不应再发 bump_cache_hits');
  // 解密失败是数据问题而非网络故障: 后续正常查询不应被熔断
  const calls2 = installFetch((url) => {
    if (url.includes('/rest/v1/translation_cache')) {
      return { ok: true, json: async () => ([{ translated: await encryptForCloud('ok text', '正常译文') }]) };
    }
    return { ok: true };
  });
  const got2 = await cloudCacheGet(key, 'ok text');
  assert.equal(got2, '正常译文', '解密失败不应触发熔断, 后续查询正常');
  assert.equal(calls2.length, 2);
});

test('cloudCacheSet 熔断: 连续 3 次失败后本会话停用云端写 (零请求)', async () => {
  store.set('vtAuthSession', {
    accessToken: 'tok-circuit', refreshToken: 'r1', userId: 'u1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600
  });
  const calls = installFetch(() => ({ ok: false }));
  for (let i = 0; i < 3; i++) {
    await cloudCacheSet('baidu|en|zh-CN|' + 'c'.repeat(64), 'baidu', 'en', 'zh-CN', '熔断原文' + i, '熔断译文' + i);
  }
  assert.equal(calls.length, 3, '3 次失败各发一次请求');
  await cloudCacheSet('baidu|en|zh-CN|' + 'd'.repeat(64), 'baidu', 'en', 'zh-CN', 'blocked原文', 'blocked译文');
  assert.equal(calls.length, 3, '熔断后不应再发起请求');
  store.clear();
  // 注意: 模块级 cloudCacheFails 已累计到 3, 本测试须置于本文件最后 (后续测试的云端写会被熔断)
});
