import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInlineMathFragment, maskInlineMath, restoreInlineMath } from '../lib/text-utils.js';


// ===== 行内公式保护 (V1.7.65) =====
test('maskInlineMath: 正文夹公式 → 占位符, 还原后与原式一致', () => {
  const src = '实验表明当 M ≥ 2 时，误差降到 1e-6。';
  const { masked, items } = maskInlineMath(src);
  assert.equal(items.length, 2, `应保护两处公式, 实际 ${items.length}`);
  assert.ok(items.some(s => s.includes('≥')), '应保护 M ≥ 2');
  assert.ok(items.some(s => s.includes('1e-6')), '应保护 1e-6');
  assert.ok(masked.includes('[['), '掩码后应含占位符');
  assert.ok(!masked.includes('≥') && !masked.includes('1e-6'), '公式不应出现在送译文本中');
  assert.ok(masked.includes('实验表明当') && masked.includes('误差降到'), '正文保留');
  // 还原: 占位符按索引替换回原式 (与引擎实际返回的排布无关)
  const fake = 'A [[0]] B [[1]] C';
  assert.equal(restoreInlineMath(fake, items), 'A ' + items[0] + ' B ' + items[1] + ' C');
  // 完整往返: 掩码文本原样返回时, 公式全部还原
  const round = restoreInlineMath(masked, items);
  assert.ok(round.includes('M ≥ 2') && round.includes('1e-6'), '往返后公式必须还原');
  assert.ok(!round.includes('[['), '不能残留占位符');
});

test('maskInlineMath: LaTeX 定界公式整段保护', () => {
  const { masked, items } = maskInlineMath('由 $E=mc^2$ 可知能量与质量成正比。');
  assert.equal(items.length, 1);
  assert.equal(items[0], '$E=mc^2$');
  assert.ok(masked.includes('[[0]]'));
});

test('maskInlineMath: 普通英文/数字/年份不误伤', () => {
  for (const s of ['state-of-the-art method', 'in 1998 the value rose', 'method CNN RNN', '效率提升 3 倍']) {
    const { items } = maskInlineMath(s);
    assert.equal(items.length, 0, `不应保护: ${s}`);
  }
  assert.equal(isInlineMathFragment('k = rate constant'), false, '含普通英文词不视为公式');
  assert.equal(isInlineMathFragment('E = mc2'), true, '纯算式视为公式');
});

test('restoreInlineMath: 引擎丢失/改写占位符时公式不丢 (追加句末)', () => {
  const items = ['x^2', 'f(x)'];
  assert.equal(restoreInlineMath('结果是 [[0]] 。', items), '结果是 x^2 。 f(x)');
  assert.equal(restoreInlineMath('结果是 【【0】】 与 ［［1］］', items), '结果是 x^2 与 f(x)');
  assert.equal(restoreInlineMath('完全丢标记', items), '完全丢标记 x^2 f(x)');
});

