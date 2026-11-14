/**
 * lib/text-utils.js 单元测试 (V1.5.47)
 * 运行: node --test test/
 * mergeHardWraps: 划词原文的逐行硬换行合并规则, 回归会直接导致译文断句错乱
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHardWraps } from '../lib/text-utils.js';

test('CJK 相邻换行直接拼接 (无空格)', () => {
  assert.equal(mergeHardWraps('中文\n换行'), '中文换行');
  assert.equal(mergeHardWraps('第一行。\n第二行。'), '第一行。第二行。');
});

test('拉丁文相邻换行以空格拼接', () => {
  assert.equal(mergeHardWraps('hello\nworld'), 'hello world');
});

test('行尾连字符断词还原', () => {
  assert.equal(mergeHardWraps('inter-\nnational'), 'international');
});

test('下一行以 CJK 开头时直接拼接 (不论上一行结尾)', () => {
  assert.equal(mergeHardWraps('abc\n中文'), 'abc中文');
});

test('空行保留为段落分隔 (不吞并、不重复)', () => {
  assert.equal(mergeHardWraps('para one\n\npara two'), 'para one\npara two');
  // 每个空行各产生一个换行 (连续空行原样保留, 不做折叠)
  assert.equal(mergeHardWraps('a\n\n\n\nb'), 'a\n\n\nb');
});

test('CRLF / CR 归一化为 LF', () => {
  assert.equal(mergeHardWraps('a\r\nb'), 'a b');
  assert.equal(mergeHardWraps('a\rb'), 'a b');
});

test('行首行尾空白剔除, 整体 trim', () => {
  assert.equal(mergeHardWraps('  a  \n  b  '), 'a b');
  assert.equal(mergeHardWraps('  hi  '), 'hi');
});

test('空输入与纯空行', () => {
  assert.equal(mergeHardWraps(''), '');
  assert.equal(mergeHardWraps('\n\n\n'), '');
  // null 不在函数契约内: 调用方 (background) 先做 String(msg.text || '').trim() 兜底
});

test('多段混合场景 (PDF 复制典型形态)', () => {
  const pdfCopy = 'Deep learning has revolu-\ntionized the field.\n\n第二段开始，\n跨越两行。\n\nThird paragraph.';
  assert.equal(mergeHardWraps(pdfCopy),
    'Deep learning has revolutionized the field.\n第二段开始，跨越两行。\nThird paragraph.');
});

test('韩文谚文相邻换行直接拼接 (V1.5.55 补 \\uac00-\\ud7a3)', () => {
  // 韩文与中日文同属无空格排版: 此前谚文音节不在 CJK 集内,
  // 词中硬换行合并会被插空格, 破坏分词与翻译
  assert.equal(mergeHardWraps('한국어\n문장'), '한국어문장');
  assert.equal(mergeHardWraps('안녕하세요.\n반갑습니다.'), '안녕하세요.반갑습니다.');
});
