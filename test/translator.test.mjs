/**
 * translator.js 纯逻辑单元测试 (V1.5.47)
 * 运行: node --test test/
 * 零依赖: node:test + node:crypto。签名测试思路——fetch 打桩捕获引擎实际发出的请求,
 * 再用 node:crypto 按各引擎官方签名算法独立重算一遍比对, 任何对签名链路
 * (规范化字符串/签名头列表/密钥派生) 的错误修改都会在此拦截 (参照 V1.3.4/V1.3.6 两类回归)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { maxRequestBytes, utf8Len, sha256Hex, validateBackendConfig, translateText, resolveCustomSlot, cacheBackendId, cloudChat, baiduTts, groupParagraphBatches, splitBatchTranslation, concurrencyForEngine, runWithConcurrency } from '../lib/translator.js';

// node:crypto 独立实现 (与被测的手写实现互为对照)
const md5hex = s => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const sha256hex = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
const toHex = b => b.toString('hex');

// ===== utf8Len: UTF-8 字节数 (分块算法的度量基础) =====
test('utf8Len 空串/ASCII/CJK/emoji(代理对)', () => {
  assert.equal(utf8Len(''), 0);
  assert.equal(utf8Len('hello'), 5);
  assert.equal(utf8Len('你好'), 6);          // 汉字 3 字节
  assert.equal(utf8Len('👍'), 4);            // 代理对不能按 UTF-16 码元算
  assert.equal(utf8Len('a你👍'), 8);         // 1 + 3 + 4
});

// ===== groupParagraphBatches / splitBatchTranslation: 段落批量翻译 (V1.7.24) =====
test('groupParagraphBatches 小段落合并为一批 (含 \\n\\n 2 字节分隔符)', () => {
  assert.deepEqual(groupParagraphBatches([], 100), []);
  assert.deepEqual(groupParagraphBatches(['a', 'b', 'c'], 100), [[0, 1, 2]]);
  // 'abc'(3) + 2 + 'def'(3) = 8 ≤ 8; 再加 'ghi' 变 13 > 8 → 两批
  assert.deepEqual(groupParagraphBatches(['abc', 'def', 'ghi'], 8), [[0, 1], [2]]);
  // 汉字 3 字节: '你好'(6) + 2 + '世界'(6) = 14; limit 13 → 各自一批
  assert.deepEqual(groupParagraphBatches(['你好', '世界'], 13), [[0], [1]]);
});

test('groupParagraphBatches 单段超限独占一批 (交由调用方切块) 且不改入参', () => {
  const texts = ['x'.repeat(20), 'y'];
  const out = groupParagraphBatches(texts, 10);
  assert.deepEqual(out, [[0], [1]]);
  assert.deepEqual(texts, ['x'.repeat(20), 'y']);
});

test('splitBatchTranslation 双换行/单换行还原, 段数不符回退 null', () => {
  assert.deepEqual(splitBatchTranslation('甲\n\n乙', 2), ['甲', '乙']);
  assert.deepEqual(splitBatchTranslation('甲\n乙', 2), ['甲', '乙']);      // 百度按行返回
  assert.deepEqual(splitBatchTranslation('  甲\n\n\n 乙  ', 2), ['甲', '乙']);
  assert.deepEqual(splitBatchTranslation('只有一段', 1), ['只有一段']);
  assert.equal(splitBatchTranslation('甲\n\n乙\n\n丙', 2), null);          // 段数不符 → 回退逐段
  assert.equal(splitBatchTranslation('', 2), null);
  assert.equal(splitBatchTranslation('甲', 0), null);
});

// ===== 并发度与受限并发执行 (V1.7.25) =====
test('concurrencyForEngine: 百度串行, 官方(DeepSeek) 12, 火山/腾讯 3, 自定义 2, 未知 1', () => {
  assert.equal(concurrencyForEngine('proxy'), 12);
  assert.equal(concurrencyForEngine('baidu'), 1);
  assert.equal(concurrencyForEngine('volcengine'), 3);
  assert.equal(concurrencyForEngine('tencent'), 3);
  assert.equal(concurrencyForEngine('custom'), 2);
  assert.equal(concurrencyForEngine('unknown'), 1);
});

test('runWithConcurrency: 全部执行, 并发不超过上限且确实并行', async () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7];
  const done = [];
  let running = 0;
  let peak = 0;
  await runWithConcurrency(items, 3, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(r => setTimeout(r, 5));
    done.push(n);
    running -= 1;
  });
  assert.equal(done.length, items.length);
  assert.equal(peak <= 3, true);
  assert.equal(peak > 1, true); // 确认真的并行
  assert.deepEqual([...done].sort((a, b) => a - b), items);
});

test('runWithConcurrency: 空数组不执行; 上限 0/非法按 1 处理', async () => {
  let ran = 0;
  await runWithConcurrency([], 3, async () => {
    ran += 1;
  });
  assert.equal(ran, 0);
  await runWithConcurrency([1, 2, 3], 0, async () => {
    ran += 1;
  });
  assert.equal(ran, 3);
  await runWithConcurrency([1], 'abc', async () => {
    ran += 1;
  });
  assert.equal(ran, 4);
});

// ===== maxRequestBytes: 引擎字节上限与 customMaxBytes 边界 =====
test('maxRequestBytes 各引擎固定上限', () => {
  assert.equal(maxRequestBytes('baidu', {}), 5500);
  assert.equal(maxRequestBytes('volcengine', {}), 12000);
  assert.equal(maxRequestBytes('tencent', {}), 1800);
  assert.equal(maxRequestBytes('custom', {}), 4000);
});

test('maxRequestBytes customMaxBytes 配置边界 (500~200000, 非法回退 4000)', () => {
  assert.equal(maxRequestBytes('custom', { customMaxBytes: 8000 }), 8000);
  assert.equal(maxRequestBytes('custom', { customMaxBytes: 500 }), 500);   // 下界含
  assert.equal(maxRequestBytes('custom', { customMaxBytes: 200000 }), 200000); // 上界含
  assert.equal(maxRequestBytes('custom', { customMaxBytes: 499 }), 4000);  // 低于下界
  assert.equal(maxRequestBytes('custom', { customMaxBytes: 200001 }), 4000); // 超上界
  assert.equal(maxRequestBytes('custom', { customMaxBytes: 500.7 }), 500); // 取整
  assert.equal(maxRequestBytes('custom', { customMaxBytes: 'abc' }), 4000);
  assert.equal(maxRequestBytes('custom', { customMaxBytes: '' }), 4000);
  assert.equal(maxRequestBytes('unknown', {}), 4000); // 未知引擎兜底
});

// ===== validateBackendConfig =====
test('validateBackendConfig 四引擎缺配置提示与齐全放行', () => {
  assert.ok(validateBackendConfig('baidu', {}));
  assert.equal(validateBackendConfig('baidu', { baiduAppId: 'a', baiduKey: 'k' }), null);
  assert.ok(validateBackendConfig('volcengine', {}));
  assert.equal(validateBackendConfig('volcengine', { volcAccessKeyId: 'a', volcSecretAccessKey: 'k' }), null);
  assert.ok(validateBackendConfig('tencent', {}));
  assert.equal(validateBackendConfig('tencent', { tencentSecretId: 'a', tencentSecretKey: 'k' }), null);
  assert.ok(validateBackendConfig('custom', { customBaseUrl: '  ' })); // 纯空白视为未配置
  assert.equal(validateBackendConfig('custom', { customBaseUrl: 'http://x/v1' }), null);
});

// ===== sha256Hex: 手写 SHA-256 对照官方已知向量与 node:crypto =====
test('sha256Hex 官方向量 (空串/abc/长文本跨块)', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  // >64 字节, 覆盖多块压缩路径
  const long = 'a'.repeat(200);
  assert.equal(sha256Hex(long), sha256hex(long));
  // CJK + emoji (多字节 UTF-8 编码路径)
  assert.equal(sha256Hex('你好，世界！🎉'), sha256hex('你好，世界！🎉'));
});

// ===== 自定义模型三槽位 (V1.5.49) =====
test('resolveCustomSlot: 新结构优先, customActive 生效且越界收敛', () => {
  const cfg = {
    customModels: [
      { baseUrl: 'http://a:11434/v1/', apiKey: '', model: 'm-a', maxBytes: 0 },
      { baseUrl: 'http://b:8000/v1', apiKey: 'sk-b', model: 'm-b', maxBytes: 8000 },
      { baseUrl: 'http://c/v1', apiKey: 'sk-c', model: 'm-c', maxBytes: 0 }
    ],
    customActive: 1
  };
  const s = resolveCustomSlot(cfg);
  assert.equal(s.baseUrl, 'http://b:8000/v1'); // 尾部斜杠剔除对槽位 0 验证
  assert.equal(s.apiKey, 'sk-b');
  assert.equal(s.model, 'm-b');
  assert.equal(s.maxBytes, 8000);
  assert.equal(resolveCustomSlot({ ...cfg, customActive: 9 }).baseUrl, 'http://c/v1'); // 越界收敛到 2
  assert.equal(resolveCustomSlot({ ...cfg, customActive: -1 }).baseUrl, 'http://a:11434/v1'); // 负值收敛到 0, 尾斜杠已剔
  // 动态增删槽位 (V1.7.46): 数组只有 2 个槽时, 选中位收敛到最后一个
  const two = { customModels: cfg.customModels.slice(0, 2), customActive: 9 };
  assert.equal(resolveCustomSlot(two).baseUrl, 'http://b:8000/v1');
});

test('resolveCustomSlot: 空数组/无新结构时回退旧扁平字段 (存量配置兼容)', () => {
  const legacy = { customBaseUrl: 'http://old:11434/v1/', customApiKey: 'sk-old', customModel: 'old-m', customMaxBytes: 6000 };
  assert.equal(resolveCustomSlot(legacy).baseUrl, 'http://old:11434/v1');
  assert.equal(resolveCustomSlot(legacy).model, 'old-m');
  assert.equal(resolveCustomSlot({ ...legacy, customModels: [] }).baseUrl, 'http://old:11434/v1'); // 空数组不视为已迁移
  assert.equal(resolveCustomSlot(legacy).maxBytes, 6000);
});

test('maxRequestBytes: custom 按启用槽位的 maxBytes 生效, 旧字段回退', () => {
  const cfg = { customModels: [{ maxBytes: 0 }, { maxBytes: 9000 }, {}], customActive: 1 };
  assert.equal(maxRequestBytes('custom', cfg), 9000);
  assert.equal(maxRequestBytes('custom', { customMaxBytes: 6000 }), 6000); // 存量旧字段
  assert.equal(maxRequestBytes('custom', { customModels: [{ maxBytes: 0 }, { maxBytes: 0 }, {}] }), 4000); // 全部未配 → 默认
});

test('validateBackendConfig: custom 启用槽位未配置时报错', () => {
  const cfg = { customModels: [{ baseUrl: 'http://a/v1' }, { baseUrl: '' }, {}], customActive: 1 };
  assert.ok(validateBackendConfig('custom', cfg)); // 槽位 1 空 → 报错
  assert.equal(validateBackendConfig('custom', { ...cfg, customActive: 0 }), null); // 槽位 0 已配 → 放行
});

test('自定义模型翻译: 按启用槽位发起请求 (URL/模型名/Key 均来自该槽位)', async () => {
  const cap = {};
  const restore = stubFetch(cap, { choices: [{ message: { content: '你好' } }] });
  try {
    const out = await translateText('hello', 'en', 'zh-CN', 'custom', {
      customModels: [
        { baseUrl: 'http://slot0:11434/v1', apiKey: 'sk-0', model: 'model-zero' },
        { baseUrl: 'http://slot1:8000/v1/', apiKey: 'sk-1', model: 'model-one' },
        { baseUrl: 'http://slot2:1/v1', apiKey: 'sk-2', model: 'model-two' }
      ],
      customActive: 1
    });
    assert.equal(out, '你好');
    assert.equal(cap.url, 'http://slot1:8000/v1/chat/completions'); // 启用槽位 1 的地址 + 尾斜杠剔除
    const body = JSON.parse(cap.body);
    assert.equal(body.model, 'model-one');
    assert.equal(cap.headers['Authorization'], 'Bearer sk-1');
  } finally { restore(); }
});
// ===== 百度语音合成 BYOK (V1.7.38) =====
test('baiduTts: 缺 AK/SK 直接报错, 不发起网络请求', async () => {
  let called = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await assert.rejects(() => baiduTts('你好', {}), /需要 API Key 与 Secret Key/);
    await assert.rejects(() => baiduTts('你好', { ak: 'a' }), /需要 API Key 与 Secret Key/);
    assert.equal(called, false);
  } finally { globalThis.fetch = orig; }
});

test('baiduTts: 先换 token 再合成 mp3, 请求体带 spd/per/aue', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body });
    if (String(url).indexOf('/oauth/2.0/token') >= 0) {
      return {
        ok: true, status: 200,
        json: async () => ({ access_token: 'tok-1' }),
        headers: { get: () => 'application/json' }
      };
    }
    return {
      ok: true, status: 200,
      arrayBuffer: async () => new Uint8Array(2048).buffer,
      headers: { get: () => 'audio/mp3' }
    };
  };
  try {
    const buf = await baiduTts('你好世界', { ak: 'ak-1', sk: 'sk-1', lang: 'zh', speed: 7, voice: '3' });
    assert.equal(buf.byteLength, 2048);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.indexOf('client_id=ak-1') >= 0);
    assert.ok(calls[0].url.indexOf('client_secret=sk-1') >= 0);
    const form = new URLSearchParams(calls[1].body);
    assert.equal(form.get('tok'), 'tok-1');
    assert.equal(form.get('tex'), '你好世界');
    assert.equal(form.get('spd'), '7');
    assert.equal(form.get('per'), '3');
    assert.equal(form.get('aue'), '3');
  } finally { globalThis.fetch = orig; }
});

// ===== fetch 打桩: 捕获引擎请求, 返回假成功响应 (respOverrides 可模拟 HTTP 失败) =====
function stubFetch(capture, fakeResponse, respOverrides) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capture.url = String(url);
    capture.headers = opts.headers;
    capture.body = opts.body;
    return Object.assign({ ok: true, status: 200, json: async () => fakeResponse }, respOverrides || {});
  };
  return () => { globalThis.fetch = orig; };
}

// ===== 百度: MD5 签名 + 语言映射 =====
test('百度签名全链路 (appid+q+salt+key 的 MD5) 与语言映射', async () => {
  const cap = {};
  const restore = stubFetch(cap, { trans_result: [{ src: 'hello', dst: '你好' }] });
  try {
    const out = await translateText('hello', 'auto', 'zh-CN', 'baidu',
      { baiduAppId: 'appid123', baiduKey: 'key456' });
    assert.equal(out, '你好');
    const p = new URLSearchParams(cap.body);
    assert.equal(p.get('appid'), 'appid123');
    assert.equal(p.get('q'), 'hello');
    assert.equal(p.get('from'), 'auto');
    assert.equal(p.get('to'), 'zh'); // zh-CN → zh 映射
    // 用捕获的 salt 独立重算签名
    assert.equal(p.get('sign'), md5hex('appid123' + 'hello' + p.get('salt') + 'key456'));
  } finally { restore(); }
});

test('百度日文映射 ja → jp', async () => {
  const cap = {};
  const restore = stubFetch(cap, { trans_result: [{ dst: 'x' }] });
  try {
    await translateText('hi', 'ja', 'en', 'baidu', { baiduAppId: 'a', baiduKey: 'k' });
    assert.equal(new URLSearchParams(cap.body).get('from'), 'jp');
  } finally { restore(); }
});

test('百度签名 UTF-8 向量: CRLF/多字节/emoji 与 node:crypto 一致 (V1.5.55)', async () => {
  const cap = {};
  const restore = stubFetch(cap, { trans_result: [{ dst: 'x' }] });
  try {
    // CRLF + CJK + 代理对 emoji: 旧 Utf8Encode 把签名输入的 CRLF 改写为 LF 而发送的 q 原样
    // (服务端按收到的 q 重算不一致 → 54001); 代理对走 3 字节分支被编成 CESU-8 → 签名必错
    const text = '第一行\r\n第二行 🚀 end';
    await translateText(text, 'auto', 'zh', 'baidu', { baiduAppId: 'appid123', baiduKey: 'key456' });
    const p = new URLSearchParams(cap.body);
    assert.equal(p.get('q'), text, '发送的 q 保持原文 (CRLF 原样)');
    assert.equal(p.get('sign'), md5hex('appid123' + text + p.get('salt') + 'key456'),
      '签名按 q 原文的 UTF-8 字节计算, 与 node:crypto md5 一致');
  } finally { restore(); }
});

// ===== 火山 V4: HMAC-SHA256 派生链 (V1.3.4 回归点: X-Date 头) =====
test('火山 V4 签名全链路: 规范化请求/签名头/X-Date', async () => {
  const cap = {};
  const restore = stubFetch(cap, { TranslationList: [{ Translation: '你好世界' }] });
  try {
    const out = await translateText('hello world', 'en', 'zh-CN', 'volcengine',
      { volcAccessKeyId: 'AKTEST', volcSecretAccessKey: 'SKTEST' });
    assert.equal(out, '你好世界');

    const ts = cap.headers['X-Date'];
    assert.ok(ts, '必须携带 X-Date 头 (V1.3.4 回归: 误用 X-Content-Date 导致 400)');
    const date = ts.substring(0, 8);
    const canonicalHeaders = `content-type:application/json\nhost:open.volcengineapi.com\nx-date:${ts}\n`;
    const canonicalRequest = `POST\n/\nAction=TranslateText&Version=2020-06-01\n` +
      `${canonicalHeaders}\ncontent-type;host;x-date\n${sha256hex(cap.body)}`;
    const stringToSign = `HMAC-SHA256\n${ts}\n${date}/cn-north-1/translate/request\n${sha256hex(canonicalRequest)}`;
    const kDate = hmac('SKTEST', date);
    const kRegion = hmac(kDate, 'cn-north-1');
    const kService = hmac(kRegion, 'translate');
    const kSigning = hmac(kService, 'request');
    const expectSig = toHex(hmac(kSigning, stringToSign));

    const auth = cap.headers['Authorization'];
    assert.ok(auth.startsWith('HMAC-SHA256 Credential=AKTEST/'), 'Credential 前缀');
    assert.equal((auth.match(/Signature=([0-9a-f]{64})/) || [])[1], expectSig, '签名与独立重算一致');
  } finally { restore(); }
});

// ===== 腾讯 TC3: 派生密钥 TC3 前缀 + x-tc-action 小写 (V1.3.6 两处回归点) =====
test('腾讯 TC3 签名全链路: TC3 前缀/x-tc-action 参与签名', async () => {
  const cap = {};
  const restore = stubFetch(cap, { Response: { TargetText: '你好' } });
  try {
    const out = await translateText('hello', 'en', 'zh-CN', 'tencent',
      { tencentSecretId: 'IDTEST', tencentSecretKey: 'KEYTEST' });
    assert.equal(out, '你好');

    const ts = Number(cap.headers['X-TC-Timestamp']);
    const date = new Date(ts * 1000).toISOString().split('T')[0];
    // x-tc-action 必须小写参与签名 (V1.3.6 回归点之一)
    const canonicalHeaders = `content-type:application/json\nhost:tmt.tencentcloudapi.com\nx-tc-action:texttranslate\n`;
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\ncontent-type;host;x-tc-action\n${sha256hex(cap.body)}`;
    const stringToSign = `TC3-HMAC-SHA256\n${ts}\n${date}/tmt/tc3_request\n${sha256hex(canonicalRequest)}`;
    // 派生密钥必须带 "TC3" 前缀 (V1.3.6 回归点之二)
    const kDate = hmac('TC3' + 'KEYTEST', date);
    const kService = hmac(kDate, 'tmt');
    const kSigning = hmac(kService, 'tc3_request');
    const expectSig = toHex(hmac(kSigning, stringToSign));

    const auth = cap.headers['Authorization'];
    assert.ok(auth.startsWith('TC3-HMAC-SHA256 Credential=IDTEST/'), 'Credential 前缀');
    assert.equal((auth.match(/Signature=([0-9a-f]{64})/) || [])[1], expectSig, '签名与独立重算一致');
  } finally { restore(); }
});

// ===== 中文原文方向: 发一句中文验证全链路返回译文 (V1.5.53) =====
test('中文→英文: 四引擎各发一句中文并断言返回译文', async () => {
  const cap = {};
  // 百度: zh-CN→zh 映射, 多段 trans_result 按换行拼接
  let restore = stubFetch(cap, { trans_result: [
    { src: '你好，世界', dst: 'Hello, world' },
    { src: '早上好', dst: 'Good morning' }
  ] });
  try {
    const out = await translateText('你好，世界\n早上好', 'zh-CN', 'en', 'baidu', { baiduAppId: 'a', baiduKey: 'k' });
    assert.equal(out, 'Hello, world\nGood morning');
    const p = new URLSearchParams(cap.body);
    assert.equal(p.get('from'), 'zh'); // zh-CN → zh 映射
    assert.equal(p.get('to'), 'en');
    assert.equal(p.get('q'), '你好，世界\n早上好');
  } finally { restore(); }
  // 火山: SourceLanguage/TargetLanguage 随语种
  restore = stubFetch(cap, { TranslationList: [{ Translation: 'Hello world' }] });
  try {
    assert.equal(await translateText('你好世界', 'zh-CN', 'en', 'volcengine', { volcAccessKeyId: 'a', volcSecretAccessKey: 'k' }), 'Hello world');
    const body = JSON.parse(cap.body);
    assert.equal(body.SourceLanguage, 'zh');
    assert.equal(body.TargetLanguage, 'en');
  } finally { restore(); }
  // 腾讯: SourceText 原文透传, Source/Target 随语种
  restore = stubFetch(cap, { Response: { TargetText: 'Hello, world' } });
  try {
    assert.equal(await translateText('你好，世界', 'zh-CN', 'en', 'tencent', { tencentSecretId: 'a', tencentSecretKey: 'k' }), 'Hello, world');
    const payload = JSON.parse(cap.body);
    assert.equal(payload.SourceText, '你好，世界');
    assert.equal(payload.Target, 'en');
  } finally { restore(); }
  // 自定义模型: 中文原文进 messages, 译文出 choices
  restore = stubFetch(cap, { choices: [{ message: { content: 'Hello, world' } }] });
  try {
    assert.equal(await translateText('你好，世界', 'zh-CN', 'en', 'custom', { customBaseUrl: 'http://x:11434/v1' }), 'Hello, world');
    assert.ok(JSON.stringify(JSON.parse(cap.body).messages).includes('你好，世界'), '中文原文应进入请求体');
  } finally { restore(); }
});

// 火山不支持自动检测源语言: auto 必须在本地拦截, 不能把非法值发给上游 (V1.7.43)
test('火山 auto 源语言: 本地拒绝且零网络', async () => {
  const cap = {};
  const restore = stubFetch(cap, { TranslationList: [] });
  try {
    await assert.rejects(
      () => translateText('hello', 'auto', 'zh', 'volcengine', { volcAccessKeyId: 'a', volcSecretAccessKey: 'k' }),
      /火山翻译不支持自动检测源语言/
    );
    assert.equal(cap.url, undefined);
  } finally { restore(); }
});

// ===== 引擎错误路径: 服务端错误结构 → 带前缀可读错误 (V1.5.53) =====
test('引擎错误路径: 各引擎服务端错误结构 → 带前缀可读错误', async () => {
  const cap = {};
  // 百度 error_code/error_msg
  let restore = stubFetch(cap, { error_code: '54003', error_msg: '访问频率受限' });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'baidu', { baiduAppId: 'a', baiduKey: 'k' }),
      /百度翻译: 百度错误 54003: 访问频率受限/
    );
  } finally { restore(); }
  // 火山 ResponseMetadata.Error
  restore = stubFetch(cap, { ResponseMetadata: { Error: { Message: 'AccessDenied' } } });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'volcengine', { volcAccessKeyId: 'a', volcSecretAccessKey: 'k' }),
      /火山翻译: 火山错误: AccessDenied/
    );
  } finally { restore(); }
  // 腾讯 Response.Error
  restore = stubFetch(cap, { Response: { Error: { Message: 'AuthFailure' } } });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'tencent', { tencentSecretId: 'a', tencentSecretKey: 'k' }),
      /腾讯翻译: 腾讯错误: AuthFailure/
    );
  } finally { restore(); }
  // 自定义模型空 choices
  restore = stubFetch(cap, { choices: [] });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'custom', { customBaseUrl: 'http://x/v1' }),
      /自定义模型: 模型返回空结果/
    );
  } finally { restore(); }
});

// ===== 配额类错误升级引导 (V1.7.4): 撞免费额度/限流 → 错误文案附 Pro 引导; 非配额错误不附 =====
test('配额类错误附 Pro 升级引导; 非配额错误不附 (V1.7.4)', async () => {
  const cap = {};
  // 百度 54003 访问频率受限 (QPS 超限) → 附引导
  let restore = stubFetch(cap, { error_code: '54003', error_msg: '访问频率受限' });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'baidu', { baiduAppId: 'a', baiduKey: 'k' }),
      /百度翻译: 百度错误 54003: 访问频率受限[\s\S]*升级 Pro/
    );
  } finally { restore(); }
  // 百度 54004 账户余额不足 (免费月额度耗尽) → 附引导
  restore = stubFetch(cap, { error_code: '54004', error_msg: '账户余额不足' });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'baidu', { baiduAppId: 'a', baiduKey: 'k' }),
      /百度翻译: 百度错误 54004: 账户余额不足[\s\S]*升级 Pro/
    );
  } finally { restore(); }
  // 百度 52003 未授权用户 (非配额) → 不附引导
  restore = stubFetch(cap, { error_code: '52003', error_msg: '未授权用户' });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'baidu', { baiduAppId: 'a', baiduKey: 'k' }),
      (err) => /52003/.test(err.message) && !/升级 Pro/.test(err.message)
    );
  } finally { restore(); }
  // 火山 HTTP 429 FlowLimitExceeded 触发流控 → 附引导 (HTTP 路径需提取 Code, V1.7.4 修复)
  restore = stubFetch(cap, { ResponseMetadata: { Error: { Code: 'FlowLimitExceeded', Message: '触发流控' } } }, { ok: false, status: 429 });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'volcengine', { volcAccessKeyId: 'a', volcSecretAccessKey: 'k' }),
      /火山翻译: HTTP 429: 触发流控[\s\S]*升级 Pro/
    );
  } finally { restore(); }
  // 火山 body 路径 LimitExceeded → 附引导
  restore = stubFetch(cap, { ResponseMetadata: { Error: { Code: 'LimitExceeded', Message: '请求频率超限' } } });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'volcengine', { volcAccessKeyId: 'a', volcSecretAccessKey: 'k' }),
      /火山翻译: 火山错误: 请求频率超限[\s\S]*升级 Pro/
    );
  } finally { restore(); }
  // 腾讯 LimitExceeded 请求的次数超过限制 → 附引导
  restore = stubFetch(cap, { Response: { Error: { Code: 'LimitExceeded', Message: '请求的次数超过限制' } } });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'tencent', { tencentSecretId: 'a', tencentSecretKey: 'k' }),
      /腾讯翻译: 腾讯错误: 请求的次数超过限制[\s\S]*升级 Pro/
    );
  } finally { restore(); }
  // 腾讯 ResourcesSoldOut 资源售罄 → 附引导
  restore = stubFetch(cap, { Response: { Error: { Code: 'ResourcesSoldOut', Message: '资源售罄' } } });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'tencent', { tencentSecretId: 'a', tencentSecretKey: 'k' }),
      /腾讯翻译: 腾讯错误: 资源售罄[\s\S]*升级 Pro/
    );
  } finally { restore(); }
  // 腾讯 AuthFailure (非配额) → 不附引导
  restore = stubFetch(cap, { Response: { Error: { Code: 'AuthFailure', Message: 'AuthFailure' } } });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'tencent', { tencentSecretId: 'a', tencentSecretKey: 'k' }),
      (err) => /AuthFailure/.test(err.message) && !/升级 Pro/.test(err.message)
    );
  } finally { restore(); }
});

test('引擎 HTTP 失败路径: 状态码+错误消息; Ollama 403 给 CORS 修复提示, 非 localhost 403 不误报', async () => {
  const cap = {};
  // 百度 540 (非法密钥) 携带 error_msg
  let restore = stubFetch(cap, { error_msg: 'Invalid Access Token' }, { ok: false, status: 540 });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'baidu', { baiduAppId: 'a', baiduKey: 'bad' }),
      /百度翻译: HTTP 540: Invalid Access Token/
    );
  } finally { restore(); }
  // custom 指向 localhost 的 403 → Ollama CORS 修复提示
  restore = stubFetch(cap, { error: { message: 'forbidden' } }, { ok: false, status: 403 });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'custom', { customBaseUrl: 'http://localhost:11434/v1' }),
      /自定义模型: Ollama 拒绝了扩展的跨域请求/
    );
  } finally { restore(); }
  // custom 非 localhost 403 → 普通 HTTP 错误 (不误报 Ollama 提示)
  restore = stubFetch(cap, { error: { message: 'forbidden' } }, { ok: false, status: 403 });
  try {
    await assert.rejects(
      () => translateText('hi', 'en', 'zh-CN', 'custom', { customBaseUrl: 'http://x/v1' }),
      /自定义模型: HTTP 403: forbidden/
    );
  } finally { restore(); }
});

// ===== 官方引擎 proxy (V1.7.0 阶段2): Edge Function translate 代理百度, Pro 专享免配置 =====

// chrome.storage 会话打桩: get 返回 vtAuthSession + vtEntitlement 套餐缓存
// (session 为 null 时返回空对象 = 未登录; plan 默认 'pro', V1.7.1 预检用;
//  staleMs 偏移 fetchedAt 模拟缓存过期; set 写回 data 模拟真实落库供后续读取)
function stubChromeSession(session, plan, staleMs) {
  const orig = globalThis.chrome;
  const data = session ? { vtAuthSession: session } : {};
  if (session) {
    data.vtEntitlement = {
      userId: session.userId,
      fetchedAt: Date.now() + (staleMs || 0),
      value: {
        plan: plan || 'pro',
        maxRecords: 300, maxBytes: 209715200, expiresAt: null,
        proxyDailyLimit: 200000, proxyUsedChars: 0
      }
    };
  }
  globalThis.chrome = { storage: { local: {
    get: async () => data,
    set: async (obj) => { Object.assign(data, obj); },
    remove: async () => {}
  } } };
  return () => {
    if (orig === undefined) delete globalThis.chrome;
    else globalThis.chrome = orig;
  };
}

// expiresAt 给未来 1 小时: getValidSession 判定未过期直接返回, 不触发续期网络 (V1.7.1 预检依赖)
const PROXY_SESSION = { userId: 'u-123', accessToken: 'tok-abc', email: 'a@b.c', expiresAt: Math.floor(Date.now() / 1000) + 3600 };

// V1.7.8: 记录 storage 写入的 chrome 桩 (校验 vtProxyUsage 落库)
function stubUsageChrome(writes) {
  const orig = globalThis.chrome;
  globalThis.chrome = { storage: { local: {
    get: async () => ({
      vtAuthSession: PROXY_SESSION,
      vtEntitlement: {
        userId: PROXY_SESSION.userId, fetchedAt: Date.now(),
        value: { plan: 'pro', maxRecords: 300, maxBytes: 209715200, expiresAt: null, proxyDailyLimit: 200000, proxyUsedChars: 0 }
      }
    }),
    set: async (obj) => { writes.push(obj); },
    remove: async () => {}
  } } };
  return () => {
    if (orig === undefined) delete globalThis.chrome;
    else globalThis.chrome = orig;
  };
}

test('proxy: 免配置放行 + 字节上限 2000 (DeepSeek 延迟控制) + 缓存键透传', () => {
  assert.equal(validateBackendConfig('proxy', {}), null); // 官方引擎免配置
  assert.equal(maxRequestBytes('proxy', {}), 2000);       // V1.7.75 官方引擎缩短单次输出
  assert.equal(cacheBackendId('proxy', {}), 'proxy');     // 非 custom 原样透传, 与 BYOK 缓存隔离
});

test('proxy: 未登录 → 引导登录错误 (零网络)', async () => {
  const cap = {};
  const restoreFetch = stubFetch(cap, {}); // 若误发请求会污染 cap, 断言兜底
  const restoreChrome = stubChromeSession(null);
  try {
    await assert.rejects(
      () => translateText('hello', 'en', 'zh-CN', 'proxy', {}),
      /官方引擎需要登录/
    );
    assert.equal(cap.url, undefined, '未登录不应发起任何网络请求');
  } finally { restoreFetch(); restoreChrome(); }
});

test('proxy: 非 Pro 客户端预检 → 本地快速拦截 (零网络, V1.7.1)', async () => {
  const cap = {};
  const restoreFetch = stubFetch(cap, {}); // 若误发请求会污染 cap, 断言兜底
  const restoreChrome = stubChromeSession(PROXY_SESSION, 'free');
  try {
    await assert.rejects(
      () => translateText('hello', 'en', 'zh-CN', 'proxy', {}),
      /Pro 专享/
    );
    assert.equal(cap.url, undefined, '非 Pro 应本地拦截, 不发起任何网络请求');
  } finally { restoreFetch(); restoreChrome(); }
});

// 按 URL 后缀分发的 fetch 打桩 (V1.7.1 预检链: entitlement 与 translate 两请求按序)
function stubFetchRoutes(capture, routes) {
  const orig = globalThis.fetch;
  capture.calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    capture.calls.push({ url: u, opts: opts });
    for (const pair of routes) {
      if (u.endsWith(pair[0])) {
        return Object.assign({ ok: true, status: 200, json: async () => pair[1] });
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: 'no route: ' + u }) };
  };
  return () => { globalThis.fetch = orig; };
}

test('proxy: 套餐缓存过期 → 先查 entitlement 判 pro 再翻译 (两请求按序, V1.7.1)', async () => {
  const cap = {};
  const restoreFetch = stubFetchRoutes(cap, [
    ['/functions/v1/entitlement', { plan: 'pro', maxRecords: 300, maxBytes: 209715200, expiresAt: '2027-10-14T00:00:00Z', proxyDailyLimit: 200000, proxyUsedChars: 5 }],
    ['/functions/v1/translate', { ok: true, translated: '你好' }]
  ]);
  // 会话在但套餐缓存一小时前过期 → 预检须走网络查 entitlement
  const restoreChrome = stubChromeSession(PROXY_SESSION, 'pro', -3600 * 1000);
  try {
    const out = await translateText('hello', 'en', 'zh-CN', 'proxy', {});
    assert.equal(out, '你好');
    assert.equal(cap.calls.length, 2, '预检 + 翻译两个请求');
    assert.ok(cap.calls[0].url.endsWith('/functions/v1/entitlement'), '第一个请求应为套餐查询');
    assert.ok(cap.calls[1].url.endsWith('/functions/v1/translate'), '第二个请求应为翻译');
  } finally { restoreFetch(); restoreChrome(); }
});

test('proxy: 套餐缓存过期 + 服务端判 free → 拦截且不发起翻译请求 (V1.7.1)', async () => {
  const cap = {};
  const restoreFetch = stubFetchRoutes(cap, [
    ['/functions/v1/entitlement', { plan: 'free', maxRecords: 30, maxBytes: 52428800 }],
    ['/functions/v1/translate', { ok: true, translated: '不应到达' }]
  ]);
  // 本地缓存仍是 pro 但已过期 (降级场景): 预检网络查询判 free → 拦截
  const restoreChrome = stubChromeSession(PROXY_SESSION, 'pro', -3600 * 1000);
  try {
    await assert.rejects(
      () => translateText('hello', 'en', 'zh-CN', 'proxy', {}),
      /Pro 专享/
    );
    assert.equal(cap.calls.length, 1, '只应有套餐查询一个请求, 不发起翻译');
    assert.ok(cap.calls[0].url.endsWith('/functions/v1/entitlement'));
  } finally { restoreFetch(); restoreChrome(); }
});

test('proxy: 请求形态 (POST /functions/v1/translate, apikey+Bearer, JSON 体透传语言码)', async () => {
  const cap = {};
  const restoreFetch = stubFetch(cap, { ok: true, translated: '你好' });
  const restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    const out = await translateText('hello', 'auto', 'zh-CN', 'proxy', {});
    assert.equal(out, '你好');
    assert.equal(cap.url, 'https://sb.xiaoti.click/functions/v1/translate');
    assert.equal(cap.headers['apikey'], 'sb_publishable_PLAfFAkZRqoB1FpTWkGlsQ_FHc77Jyg');
    assert.equal(cap.headers['Authorization'], 'Bearer tok-abc');
    assert.equal(cap.headers['Content-Type'], 'application/json');
    const body = JSON.parse(cap.body);
    assert.equal(body.text, 'hello');
    assert.equal(body.from, 'auto');   // 语言映射在服务端做, 客户端透传原始码
    assert.equal(body.to, 'zh-CN');
  } finally { restoreFetch(); restoreChrome(); }
});

test('proxy: 服务端回传当日用量 → 落 vtProxyUsage 仅供展示, 不影响翻译结果 (V1.7.8)', async () => {
  const cap = {};
  const restoreFetch = stubFetch(cap, {
    ok: true, translated: '你好',
    proxyUsedChars: 1234, proxyDailyLimit: 200000, proxyRemainingChars: 198766
  });
  const writes = [];
  const restoreChrome = stubUsageChrome(writes);
  try {
    const out = await translateText('hello', 'auto', 'zh-CN', 'proxy', {});
    assert.equal(out, '你好');
    const w = writes.find(o => o && o.vtProxyUsage);
    assert.ok(w, '应写入 vtProxyUsage');
    assert.equal(w.vtProxyUsage.userId, 'u-123');
    assert.equal(w.vtProxyUsage.usedChars, 1234);
    assert.equal(w.vtProxyUsage.dailyLimit, 200000);
    assert.equal(typeof w.vtProxyUsage.time, 'number');
  } finally { restoreFetch(); restoreChrome(); }
});

test('proxy: 响应缺用量字段或余量为 0 时不拦截翻译 (V1.7.8)', async () => {
  // 老版本服务端无用量字段: 不写缓存, 照常返回译文
  let cap = {};
  let restoreFetch = stubFetch(cap, { ok: true, translated: 'A' });
  let writes = [];
  let restoreChrome = stubUsageChrome(writes);
  try {
    assert.equal(await translateText('hi', 'en', 'zh-CN', 'proxy', {}), 'A');
    assert.equal(writes.filter(o => o && o.vtProxyUsage).length, 0);
  } finally { restoreFetch(); restoreChrome(); }
  // 余量 0: 本次仍返回译文——判定永远在服务端, 客户端不做额外拦截
  cap = {};
  restoreFetch = stubFetch(cap, { ok: true, translated: 'B', proxyUsedChars: 200000, proxyDailyLimit: 200000, proxyRemainingChars: 0 });
  writes = [];
  restoreChrome = stubUsageChrome(writes);
  try {
    assert.equal(await translateText('hi', 'en', 'zh-CN', 'proxy', {}), 'B');
    const w = writes.find(o => o && o.vtProxyUsage);
    assert.equal(w.vtProxyUsage.usedChars, 200000);
  } finally { restoreFetch(); restoreChrome(); }
});

test('proxy: 服务端状态码 → 可读错误 (401 重登 / 403 Pro 专享 / 429 配额 / 503 未开放)', async () => {
  const cap = {};
  // 401: 会话过期 → 引导重新登录
  let restoreFetch = stubFetch(cap, { error: 'unauthorized' }, { ok: false, status: 401 });
  let restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    await assert.rejects(() => translateText('hi', 'en', 'zh-CN', 'proxy', {}), /官方引擎需要登录：请点击插件图标，在底部「账户」重新登录/);
  } finally { restoreFetch(); restoreChrome(); }
  // 403: 非 Pro / Pro 过期
  restoreFetch = stubFetch(cap, { error: 'pro required' }, { ok: false, status: 403 });
  restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    await assert.rejects(() => translateText('hi', 'en', 'zh-CN', 'proxy', {}), /官方引擎为 Pro 专享功能/);
  } finally { restoreFetch(); restoreChrome(); }
  // 429: 日字符配额用尽
  restoreFetch = stubFetch(cap, { error: 'daily limit exceeded' }, { ok: false, status: 429 });
  restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
      await assert.rejects(() => translateText('hi', 'en', 'zh-CN', 'proxy', {}), /今日官方翻译额度已用完/);
  } finally { restoreFetch(); restoreChrome(); }
  // 503: 服务端 secrets 未配置
  restoreFetch = stubFetch(cap, { error: 'proxy not configured' }, { ok: false, status: 503 });
  restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    await assert.rejects(() => translateText('hi', 'en', 'zh-CN', 'proxy', {}), /官方引擎暂未开放/);
  } finally { restoreFetch(); restoreChrome(); }
});

test('proxy: 空译文 → 报错 (不留隐患)', async () => {
  const cap = {};
  const restoreFetch = stubFetch(cap, { ok: true, translated: '' });
  const restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    await assert.rejects(() => translateText('hi', 'en', 'zh-CN', 'proxy', {}), /官方引擎返回空结果/);
  } finally { restoreFetch(); restoreChrome(); }
});

// ===== 云端大模型对话 cloudChat (V1.7.10): Edge Function ai-chat 代理 DeepSeek, Pro 专享 =====
// 与 customChat 同签名 (可注入 analyzeDocument 的 opts.chat); 服务端计费仅输入字符。

test('cloudChat: 未登录 → 引导登录错误 (零网络)', async () => {
  const cap = {};
  const restoreFetch = stubFetch(cap, {});
  const restoreChrome = stubChromeSession(null);
  try {
    await assert.rejects(() => cloudChat([{ role: 'user', content: '你好' }], {}), /云端 AI 分析需要登录/);
    assert.equal(cap.url, undefined, '未登录不应发起任何网络请求');
  } finally { restoreFetch(); restoreChrome(); }
});

test('cloudChat: 非 Pro 客户端预检 → 本地快速拦截 (零网络)', async () => {
  const cap = {};
  const restoreFetch = stubFetch(cap, {});
  const restoreChrome = stubChromeSession(PROXY_SESSION, 'free');
  try {
    await assert.rejects(() => cloudChat([{ role: 'user', content: '你好' }], {}), /云端 AI 分析为 Pro 专享/);
    assert.equal(cap.url, undefined, '非 Pro 应本地拦截, 不发起任何网络请求');
  } finally { restoreFetch(); restoreChrome(); }
});

test('cloudChat: 请求形态 (POST /functions/v1/ai-chat, apikey+Bearer, messages/temperature 透传)', async () => {
  const cap = {};
  const restoreFetch = stubFetch(cap, { content: '  分析结果  ', aiUsedChars: 500, aiDailyLimit: 100000, aiRemainingChars: 99500 });
  const restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    const out = await cloudChat(
      [{ role: 'user', content: '请分析这篇文档' }],
      {},
      { temperature: 0.5 }
    );
    assert.equal(out, '分析结果', '结果提取并 trim');
    assert.equal(cap.url, 'https://sb.xiaoti.click/functions/v1/ai-chat');
    assert.equal(cap.headers['apikey'], 'sb_publishable_PLAfFAkZRqoB1FpTWkGlsQ_FHc77Jyg');
    assert.equal(cap.headers['Authorization'], 'Bearer tok-abc');
    assert.equal(cap.headers['Content-Type'], 'application/json');
    const body = JSON.parse(cap.body);
    assert.deepEqual(body.messages, [{ role: 'user', content: '请分析这篇文档' }]);
    assert.equal(body.temperature, 0.5);
  } finally { restoreFetch(); restoreChrome(); }
});

test('cloudChat: 服务端回传当日用量 → 落 vtAiUsage 仅供展示 (V1.7.10)', async () => {
  const cap = {};
  const restoreFetch = stubFetch(cap, { content: '结果', aiUsedChars: 4321, aiDailyLimit: 100000, aiRemainingChars: 95679 });
  const writes = [];
  const restoreChrome = stubUsageChrome(writes);
  try {
    const out = await cloudChat([{ role: 'user', content: 'hi' }], {});
    assert.equal(out, '结果');
    const w = writes.find(o => o && o.vtAiUsage);
    assert.ok(w, '应写入 vtAiUsage');
    assert.equal(w.vtAiUsage.userId, 'u-123');
    assert.equal(w.vtAiUsage.usedChars, 4321);
    assert.equal(w.vtAiUsage.dailyLimit, 100000);
    assert.equal(typeof w.vtAiUsage.time, 'number');
  } finally { restoreFetch(); restoreChrome(); }
});

test('cloudChat: 服务端状态码 → 可读错误 (401 重登 / 403 Pro 专享 / 429 配额 / 503 未开放 / 502 上游)', async () => {
  const cap = {};
  // 401: 会话过期 → 引导重新登录
  let restoreFetch = stubFetch(cap, { error: 'unauthorized' }, { ok: false, status: 401 });
  let restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    await assert.rejects(() => cloudChat([{ role: 'user', content: 'hi' }], {}), /云端 AI 分析需要登录：请点击插件图标，在底部「账户」重新登录/);
  } finally { restoreFetch(); restoreChrome(); }
  // 403: 服务端判定非 Pro (Pro 过期降级场景, 客户端 3 分钟缓存未感知)
  restoreFetch = stubFetch(cap, { error: 'pro required' }, { ok: false, status: 403 });
  restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    await assert.rejects(() => cloudChat([{ role: 'user', content: 'hi' }], {}), /云端 AI 分析为 Pro 专享功能/);
  } finally { restoreFetch(); restoreChrome(); }
  // 429: 输入字符日配额用尽
  restoreFetch = stubFetch(cap, { error: 'daily limit exceeded' }, { ok: false, status: 429 });
  restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    await assert.rejects(() => cloudChat([{ role: 'user', content: 'hi' }], {}), /今日云端 AI 分析字符配额已用完/);
  } finally { restoreFetch(); restoreChrome(); }
  // 503: 服务端 DEEPSEEK_API_KEY 未配置
  restoreFetch = stubFetch(cap, { error: 'ai not configured' }, { ok: false, status: 503 });
  restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    await assert.rejects(() => cloudChat([{ role: 'user', content: 'hi' }], {}), /云端 AI 分析暂未开放/);
  } finally { restoreFetch(); restoreChrome(); }
  // 502: DeepSeek 上游失败透传
  restoreFetch = stubFetch(cap, { error: 'deepseek: HTTP 500: boom' }, { ok: false, status: 502 });
  restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    await assert.rejects(() => cloudChat([{ role: 'user', content: 'hi' }], {}), /HTTP 502: deepseek: HTTP 500: boom/);
  } finally { restoreFetch(); restoreChrome(); }
});

test('cloudChat: 空 content → 报错 (不留隐患)', async () => {
  const cap = {};
  const restoreFetch = stubFetch(cap, { content: '' });
  const restoreChrome = stubChromeSession(PROXY_SESSION);
  try {
    await assert.rejects(() => cloudChat([{ role: 'user', content: 'hi' }], {}), /云端 AI 返回空结果/);
  } finally { restoreFetch(); restoreChrome(); }
});
