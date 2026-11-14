import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTableRows, detectTableParagraphs, tableColumnsAligned } from '../lib/table-detect.js';

// 构造一行: cells = [{x, text}], 每格按 5pt/字符 估宽
function line(y, cells, fontSize = 10) {
  const items = [];
  for (const c of cells) {
    items.push({ str: c.text, x: c.x, width: c.text.length * 5 });
  }
  return { y, fontSize, items };
}

test('表格识别: 3 行 × 2 列对齐表格 → 命中对应段落 (V1.7.67)', () => {
  const lines = [
    line(100, [{ x: 50, text: '指标' }, { x: 200, text: '数值' }]),
    line(114, [{ x: 50, text: '准确率' }, { x: 200, text: '0.93' }]),
    line(128, [{ x: 50, text: '召回率' }, { x: 200, text: '0.88' }]),
    line(142, [{ x: 50, text: 'F1' }, { x: 200, text: '0.90' }])
  ];
  const rows = buildTableRows(lines);
  assert.ok(rows.every(r => r && r.length === 2), '每行应拆出 2 个单元格');
  assert.equal(tableColumnsAligned(rows, 0, 3), true);
  const paras = [{ lineStart: 0, lineEnd: 3 }];
  // 纯函数返回的行下标是"在传入 lines 中的下标", 段落覆盖 ≥2 行即命中
  const set = detectTableParagraphs(lines, rows, [{ lineStart: 0, lineEnd: 3 }]);
  assert.equal(set.has(0), true);
  assert.equal(paras.length, 1);
});

test('表格识别: 双栏正文 (单元格文字长) 不误判', () => {
  // 真实双栏正文行约 40~50 字, 远超单元格上限 (30)
  const long = '这是一段很长的正文内容用于描述实验方法与结果分析并讨论其局限性以及后续改进方向';
  const lines = [
    line(100, [{ x: 40, text: long }, { x: 320, text: long }]),
    line(114, [{ x: 40, text: long }, { x: 320, text: long }]),
    line(128, [{ x: 40, text: long }, { x: 320, text: long }])
  ];
  const rows = buildTableRows(lines);
  assert.ok(rows.every(r => r === null), '长文本行不应拆成表格单元格');
  assert.equal(detectTableParagraphs(lines, rows, [{ lineStart: 0, lineEnd: 2 }]).size, 0);
});

test('表格识别: 行数不足 (<3 行) 或列不对齐不命中', () => {
  const two = [
    line(100, [{ x: 50, text: 'a' }, { x: 200, text: 'b' }]),
    line(114, [{ x: 50, text: 'c' }, { x: 200, text: 'd' }])
  ];
  assert.equal(detectTableParagraphs(two, buildTableRows(two), [{ lineStart: 0, lineEnd: 1 }]).size, 0, '2 行不算表格');

  const misaligned = [
    line(100, [{ x: 50, text: 'a' }, { x: 200, text: 'b' }]),
    line(114, [{ x: 90, text: 'c' }, { x: 260, text: 'd' }]),
    line(128, [{ x: 140, text: 'e' }, { x: 320, text: 'f' }])
  ];
  assert.equal(detectTableParagraphs(misaligned, buildTableRows(misaligned), [{ lineStart: 0, lineEnd: 2 }]).size, 0, '列起点漂移不命中');
});

test('表格识别: 行距中断 → 分块, 只有成块的连续行命中', () => {
  const lines = [
    line(100, [{ x: 50, text: 'a' }, { x: 200, text: 'b' }]),
    line(114, [{ x: 50, text: 'c' }, { x: 200, text: 'd' }]),
    line(128, [{ x: 50, text: 'e' }, { x: 200, text: 'f' }]),
    line(400, [{ x: 50, text: 'g' }, { x: 200, text: 'h' }]) // 远距离 = 另一块, 单独 1 行
  ];
  const set = detectTableParagraphs(lines, buildTableRows(lines), [
    { lineStart: 0, lineEnd: 2 },
    { lineStart: 3, lineEnd: 3 }
  ]);
  assert.equal(set.has(0), true, '前三行成表格块');
  assert.equal(set.has(1), false, '孤立行不命中');
});
