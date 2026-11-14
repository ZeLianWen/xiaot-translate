/**
 * AI 全文分析总结测试 (V1.7.9, Pro 专享)
 * 运行: node --test
 * 覆盖: splitForSummary 三级切分 (段落/句子/码点, 不丢字符不拆代理对) / 三类提示词内容 /
 * analyzeDocument 编排 (单次直出、map-reduce 调用次数与汇总整合、64 块上限、空文本) /
 * 上下文自适应 (Ollama 2048 实测场景减半重试、分批多轮汇总、非上下文错误不重试、
 * 重试耗尽报错附 OLLAMA_CONTEXT_LENGTH 引导) / customChat 请求形态 (槽位/温度/headers)
 * 与错误路径 (HTTP 错误透出、空结果、未配置地址)。
 * V1.7.12: buildChatMessages 微信式对话组装 (system 文档上下文注入、超长截断、
 * 历史按码点预算与条数上限从最新往旧裁剪)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitForSummary,
  buildSummaryPrompt,
  buildChunkPrompt,
  buildReducePrompt,
  analyzeDocument,
  buildChatMessages,
  SINGLE_MAX_BYTES,
  MAX_CHUNKS
} from '../lib/ai-summary.js';
import { customChat, utf8Len } from '../lib/translator.js';

// ===== splitForSummary: 三级切分, 每块字节不超限且内容不丢失 =====

test('splitForSummary: 短文本单块原样保留 (段落连接)', () => {
  const text = '第一段内容。\n\n第二段内容较长一些。';
  const chunks = splitForSummary(text, 1000);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes('第一段内容。'));
  assert.ok(chunks[0].includes('第二段内容较长一些。'));
});

test('splitForSummary: 多段按字节贪心装块, 每块不超限且段落不丢', () => {
  const paras = [];
  for (let i = 0; i < 20; i++) paras.push('段落' + i + '：' + '正文内容'.repeat(10)); // 每段 ~130 字节
  const text = paras.join('\n\n');
  const max = 600;
  const chunks = splitForSummary(text, max);
  assert.ok(chunks.length > 1, '应分成多块');
  for (const c of chunks) assert.ok(utf8Len(c) <= max, '每块字节不超限');
  const joined = chunks.join('\n');
  for (const p of paras) assert.ok(joined.includes(p), '段落不丢失: ' + p.substring(0, 10));
});

test('splitForSummary: 超长单段按句子边界细分, 字符不丢失', () => {
  const long = '测试句子。'.repeat(300); // 单段 1500 字节, 句子边界切分
  const chunks = splitForSummary(long, 300);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(utf8Len(c) <= 300);
  assert.equal(chunks.join('').replace(/\n/g, ''), long, '切分不丢字符');
});

test('splitForSummary: 无句子边界的超长文本按码点硬切, 代理对不拆', () => {
  const emoji = '😀'.repeat(200); // 每个 4 字节, 无句读 → 码点硬切
  const chunks = splitForSummary(emoji, 300);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(utf8Len(c) <= 300);
    assert.ok(!c.endsWith('\uD83D') && !c.endsWith('\uD83C'), '不拆代理对');
  }
  assert.equal(chunks.join(''), emoji, 'emoji 完整保留');
});

// ===== 提示词: 固定小节结构 / 输出语言 / 分块序号 / 汇总整合 =====

test('提示词: 单次含小节结构与全文; 分块含序号; 汇总含各部分要点', () => {
  const sp = buildSummaryPrompt('文档全文内容ABC', '简体中文');
  assert.ok(sp.includes('简体中文'));
  assert.ok(sp.includes('## 一句话总结'));
  assert.ok(sp.includes('## 结论与启示'));
  assert.ok(sp.includes('文档全文内容ABC'));

  const cp = buildChunkPrompt('片段原文', 'English', 3, 7);
  assert.ok(cp.includes('3/7'));
  assert.ok(cp.includes('English'));
  assert.ok(cp.includes('片段原文'));

  const rp = buildReducePrompt(['要点一', '要点二'], '简体中文');
  assert.ok(rp.includes('第 1 部分要点'));
  assert.ok(rp.includes('第 2 部分要点'));
  assert.ok(rp.includes('要点一') && rp.includes('要点二'));
});

// ===== analyzeDocument: 编排 (chat 注入打桩, 零网络) =====

test('analyzeDocument: 短文单次直出 (≤30KB 一次调用)', async () => {
  const calls = [];
  const chat = async messages => {
    calls.push(messages[0].content);
    return '分析总结结果';
  };
  const r = await analyzeDocument('这是一段短文档。', '简体中文', {}, { chat });
  assert.equal(r.mode, 'single');
  assert.equal(r.calls, 1);
  assert.equal(r.chunks, 1);
  assert.equal(r.content, '分析总结结果');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('这是一段短文档。'));
  assert.ok(calls[0].includes('简体中文'));
});

test('analyzeDocument: 长文 map-reduce (逐块提炼 + 汇总整合, 调用次数)', async () => {
  // 40KB 无句读文本 > SINGLE_MAX_BYTES(30000); 分块基准跟随 customMaxBytes 默认 4000
  // → 10 块 → 11 次调用 (10 次提炼 + 1 次汇总)
  const text = 'x'.repeat(40000);
  assert.ok(utf8Len(text) > SINGLE_MAX_BYTES);
  const calls = [];
  let n = 0;
  const chat = async messages => {
    n++;
    calls.push(messages[0].content);
    return 'part-' + n;
  };
  const progress = [];
  const r = await analyzeDocument(text, 'English', {}, {
    chat,
    onProgress: p => progress.push(p)
  });
  assert.equal(r.mode, 'map-reduce');
  assert.equal(r.chunks, 10);
  assert.equal(r.calls, 11);
  assert.equal(r.content, 'part-11'); // 最后一次调用为汇总, 产出最终结果
  assert.ok(calls[8].includes('9/10'), '分块提示词含序号');
  assert.ok(calls[9].includes('10/10'));
  assert.ok(calls[10].includes('part-1') && calls[10].includes('part-10'), '汇总提示词含各块要点');
  assert.ok(progress.some(p => p.stage === 'map' && p.cur === 1 && p.total === 10));
  assert.ok(progress.some(p => p.stage === 'reduce'));
});

test('analyzeDocument: 超过 64 块上限直接报错 (不截断不请求)', async () => {
  const text = 'y'.repeat(4000 * (MAX_CHUNKS + 36)); // 分块基准 4000 → 101 块 > 64
  const chat = async () => 'x';
  await assert.rejects(
    () => analyzeDocument(text, '简体中文', {}, { chat }),
    e => /过长/.test(e.message) && e.message.includes(String(MAX_CHUNKS))
  );
});

test('analyzeDocument: opts.chunkBaseBytes 覆盖分块基准 (云端 DeepSeek 免碎块, V1.7.10)', async () => {
  // 同样 40KB 文本: 默认基准 (customMaxBytes 4000) 10 块 11 调用;
  // 云端传 chunkBaseBytes 24000 (DeepSeek 64K token 上下文) → 2 块 + 汇总 = 3 次调用
  const text = 'x'.repeat(40000);
  const calls = [];
  const chat = async messages => {
    calls.push(messages[0].content);
    return 'r-' + calls.length;
  };
  const r = await analyzeDocument(text, '简体中文', {}, {
    chat,
    chunkBaseBytes: 24000
  });
  assert.equal(r.mode, 'map-reduce');
  assert.equal(r.chunks, 2, '24KB 基准 → 2 块 (24000 + 16000)');
  assert.equal(r.calls, 3, '2 次提炼 + 1 次汇总');
  assert.equal(r.content, 'r-3');
  assert.ok(calls[0].includes('1/2') && calls[1].includes('2/2'));
  assert.ok(calls[2].includes('r-1') && calls[2].includes('r-2'), '汇总提示词含各块要点');
});

// ===== 上下文自适应: 服务端 4xx 上下文错误自动减半分块重试 / 分批多轮汇总 =====

test('analyzeDocument: 上下文不足自动减半重试 (模拟 Ollama 2048 上下文实测场景)', async () => {
  // 模拟服务端: 提示词 >5000 字节即抛 Ollama 原始文案 (2048 tokens ≈ 放不下 10KB 全文)
  // 10KB 文本: 尝试 1/2 (limit 30000/15000) 走单次直出被拒 → 尝试 3 (limit 7500) 分块
  // (chunkBytes 4000, 提示词 ≈4330B ≤5000) → 3 块提炼 + 1 次汇总成功
  const text = 'x'.repeat(10000);
  let n = 0;
  const progress = [];
  const chat = async messages => {
    n++;
    if (utf8Len(messages[0].content) > 5000) {
      throw new Error('自定义模型: HTTP 400: request (6442 tokens) exceeds the available context size (2048 tokens), try increasing it');
    }
    return 'ok-' + n;
  };
  const r = await analyzeDocument(text, '简体中文', {}, {
    chat,
    onProgress: p => progress.push(p)
  });
  assert.equal(r.mode, 'map-reduce');
  assert.equal(r.chunks, 3);
  assert.equal(r.calls, 4, '末轮 3 次提炼 + 1 次汇总');
  assert.equal(r.content, 'ok-6', '含 2 次失败共 6 次请求, 末次产出最终结果');
  assert.equal(n, 6);
  const retries = progress.filter(p => p.stage === 'retry');
  assert.deepEqual(retries.map(p => p.cur), [2, 3], '第 2/3 次尝试触发重试进度');
  assert.ok(progress.some(p => p.stage === 'map' && p.total === 3));
});

test('analyzeDocument: 分块要点超限时分批多轮汇总 (customMaxBytes 24000)', async () => {
  // 50KB → 3 块 (每块 24000); 每块要点 12KB → 总 36KB > 单次上限 → 先分 2 批合并
  // (批 [[p1,p2],[p3]]) 再末轮整合, 共 3+2+1=6 次调用
  const text = 'z'.repeat(50000);
  const calls = [];
  const progress = [];
  const chat = async messages => {
    const c = messages[0].content;
    calls.push(c);
    if (c.includes('<文档第')) return '要点'.repeat(2000); // 12KB 要点
    if (c.includes('仍在分批整合')) return '合并'.repeat(200); // 中间轮紧凑要点
    if (c.includes('<各部分要点>')) return 'FINAL';
    throw new Error('意外的提示词: ' + c.slice(0, 40));
  };
  const r = await analyzeDocument(text, '简体中文', { customMaxBytes: 24000 }, {
    chat,
    onProgress: p => progress.push(p)
  });
  assert.equal(r.chunks, 3);
  assert.equal(r.calls, 6, '3 次提炼 + 2 次中间合并 + 1 次末轮整合');
  assert.equal(r.content, 'FINAL');
  assert.ok(calls[3].includes('仍在分批整合') && calls[4].includes('仍在分批整合'), '中间轮走合并提示词');
  assert.ok(calls[5].includes('<各部分要点>'), '末轮走汇总提示词');
  assert.ok(calls[5].includes('合并'), '末轮以中间轮紧凑要点为输入');
  const reduce = progress.filter(p => p.stage === 'reduce');
  assert.deepEqual(reduce.map(p => [p.cur, p.total]), [[1, 2], [2, 2], [1, 1]], '两批合并后单批收尾');
});

test('analyzeDocument: 非上下文错误不重试, 原样抛出', async () => {
  let n = 0;
  const chat = async () => {
    n++;
    throw new Error('自定义模型: HTTP 500: boom');
  };
  await assert.rejects(
    () => analyzeDocument('短文内容', '简体中文', {}, { chat }),
    e => /boom/.test(e.message)
  );
  assert.equal(n, 1, '仅 1 次调用, 不进入重试');
});

test('analyzeDocument: 重试耗尽报错并附 Ollama 上下文环境变量引导', async () => {
  // 恒抛上下文错误: limit 依次 30000→15000→7500→3750→1875→937, 6 次尝试后耗尽
  const limits = [];
  let n = 0;
  const chat = async messages => {
    n++;
    limits.push(utf8Len(messages[0].content));
    throw new Error('HTTP 400: exceeds the available context size (2048 tokens)');
  };
  await assert.rejects(
    () => analyzeDocument('x'.repeat(500), '简体中文', {}, { chat }),
    e => e.message.includes('OLLAMA_CONTEXT_LENGTH') && e.message.includes('上下文窗口')
  );
  assert.equal(n, 6, '共 6 次尝试 (MAX_ADJUST_ATTEMPTS)');
});

test('analyzeDocument: 空文本 / null 报错', async () => {
  const chat = async () => 'x';
  await assert.rejects(() => analyzeDocument('', '简体中文', {}, { chat }), /没有可分析/);
  await assert.rejects(() => analyzeDocument(null, '简体中文', {}, { chat }), /没有可分析/);
  await assert.rejects(() => analyzeDocument('   ', '简体中文', {}, { chat }), /没有可分析/);
});

// ===== customChat: OpenAI 兼容 /chat/completions 请求形态与错误路径 =====

test('customChat: 请求形态 (槽位 baseUrl+model / 无 key 不带 Authorization / 温度 / 流关) 与结果提取', async () => {
  const cap = [];
  globalThis.fetch = async (url, init) => {
    cap.push({ url, init });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '  分析结果  ' } }] }) };
  };
  const config = {
    customModels: [{ baseUrl: 'http://127.0.0.1:11434/v1/', apiKey: '', model: 'llama3', maxBytes: 0 }],
    customActive: 0
  };
  const out = await customChat([{ role: 'user', content: '你好' }], config, { temperature: 0.7 });
  assert.equal(out, '分析结果', '结果提取并 trim');
  assert.equal(cap.length, 1);
  assert.equal(cap[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.ok(!('Authorization' in cap[0].init.headers), '无 apiKey 不带 Authorization');
  const body = JSON.parse(cap[0].init.body);
  assert.equal(body.model, 'llama3');
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content, '你好');
  assert.equal(body.temperature, 0.7);
  assert.equal(body.stream, false);
});

test('customChat: opts.slot 显式连接参数覆盖翻译槽位 (独立 AI 模型, V1.7.11)', async () => {
  const cap = [];
  globalThis.fetch = async (url, init) => {
    cap.push({ url, init });
    return { ok: true, json: async () => ({ choices: [{ message: { content: '本地分析' } }] }) };
  };
  // 翻译槽位指向 llama3; 独立 AI 模型 slot 指向 qwen → 请求应完全走 slot
  const config = {
    customModels: [{ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'translate-key', model: 'llama3', maxBytes: 0 }],
    customActive: 0
  };
  const out = await customChat([{ role: 'user', content: 'hi' }], config, {
    slot: { baseUrl: 'http://localhost:8000/v1/', apiKey: 'ai-key', model: 'qwen2.5:7b' }
  });
  assert.equal(out, '本地分析');
  assert.equal(cap[0].url, 'http://localhost:8000/v1/chat/completions', 'slot.baseUrl (去尾斜杠) 覆盖翻译槽位');
  assert.equal(cap[0].init.headers['Authorization'], 'Bearer ai-key', 'slot.apiKey 参与鉴权头');
  assert.equal(JSON.parse(cap[0].init.body).model, 'qwen2.5:7b', 'slot.model 覆盖翻译槽位模型');
  // slot 无 baseUrl → 回退翻译槽位 (向后兼容)
  cap.length = 0;
  await customChat([{ role: 'user', content: 'hi' }], config, { slot: { model: 'x' } });
  assert.equal(cap[0].url, 'http://127.0.0.1:11434/v1/chat/completions', 'slot 无 baseUrl 回退翻译槽位');
  assert.equal(JSON.parse(cap[0].init.body).model, 'llama3', '回退后模型来自翻译槽位');
});

test('customChat: HTTP 错误透出 / 空结果报错 / 未配置地址报错', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) });
  await assert.rejects(
    () => customChat([{ role: 'user', content: 'x' }], { customBaseUrl: 'https://api.example.com/v1' }),
    /HTTP 500: boom/
  );
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [] }) });
  await assert.rejects(
    () => customChat([{ role: 'user', content: 'x' }], { customBaseUrl: 'https://api.example.com/v1' }),
    /空结果/
  );
  await assert.rejects(
    () => customChat([{ role: 'user', content: 'x' }], {}),
    /接口地址/
  );
});

// ===== buildChatMessages (V1.7.12 微信式对话): system 文档上下文注入 + 历史裁剪 =====

test('buildChatMessages: system 注入文档上下文与角色约束, 历史透传, 当前消息在末尾', () => {
  const msgs = buildChatMessages('文档内容ABC', [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二问' }
  ]);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('文档内容ABC'));
  assert.ok(msgs[0].content.includes('小T'));
  assert.deepEqual(msgs.slice(1).map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(msgs[msgs.length - 1].content, '第二问', '当前新消息必在末尾');
});

test('buildChatMessages: 超长文档按 maxDocChars 截断并附截断说明', () => {
  const doc = 'a'.repeat(500);
  const msgs = buildChatMessages(doc, [{ role: 'user', content: '问' }], { maxDocChars: 100 });
  const sys = msgs[0].content;
  assert.ok(sys.includes('文档过长'), '附截断说明');
  assert.ok(sys.includes('a'.repeat(100)), '保留前 100 字符');
  assert.ok(!sys.includes('a'.repeat(101)), '超出部分被截断');
});

test('buildChatMessages: 历史按 maxTotalChars 从最新往旧裁剪 (旧消息丢弃)', () => {
  const hist = [];
  for (let i = 0; i < 6; i++) hist.push({ role: 'user', content: ('m' + i).padEnd(100, 'x') });
  const msgs = buildChatMessages('', hist, { maxTotalChars: 400 });
  const conv = msgs.slice(1);
  assert.equal(conv.length, 2, 'system+当前消息后仅容 1 条历史');
  assert.ok(conv[0].content.startsWith('m4'), '较新历史保留');
  assert.ok(conv[1].content.startsWith('m5'), '当前消息保留');
});

test('buildChatMessages: 历史条数上限 maxMessages (含 system 与当前消息的预算)', () => {
  const hist = [];
  for (let i = 0; i < 10; i++) hist.push({ role: 'user', content: 'q' + i });
  const msgs = buildChatMessages('', hist, { maxMessages: 3 });
  assert.equal(msgs.length, 4, 'system + 2 条历史 + 当前消息');
  assert.equal(msgs[msgs.length - 1].content, 'q9');
  assert.equal(msgs[1].content, 'q7', '裁掉最旧的, 保留紧邻的 2 条历史 (时间正序)');
});

test('buildChatMessages: 空文档不注入文档段落; 非法历史条目被过滤', () => {
  const msgs = buildChatMessages('', [
    { role: 'user', content: '你好' },
    { role: 'system', content: '非法角色被过滤' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '再次提问' }
  ]);
  assert.equal(msgs.length, 3, 'system + 2 条合法 user 消息');
  assert.ok(!msgs[0].content.includes('<文档内容>'), '空文档不注入文档标记');
  assert.equal(msgs[2].content, '再次提问');
});
