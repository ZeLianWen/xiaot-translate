/**
 * 表格版面识别 (ES Module, 纯函数, V1.7.67)
 * 从 PDF 文本行几何判断表格区域, 不依赖图形/边框 (表格细边框在图形检测里会被当装饰线过滤掉)。
 * 判据: 行内相邻文字块水平间隙 ≥ gap 视为列分隔 → 连续 ≥minRows 行、每行 ≥2 个短单元格、
 *       列起点跨行对齐 → 表格。双栏正文因单元格文字过长被排除。
 */

export const TABLE_CELL_GAP = 10;        // 列间隙阈值 (1x PDF 点)
export const TABLE_MAX_CELL_CHARS = 30;  // 单元格文字长度上限 (超过视为正文行)
export const TABLE_MIN_ROWS = 3;         // 连续行下限
export const TABLE_COLUMN_TOLERANCE = 6; // 列起点对齐容差 (分桶宽度)

/**
 * 逐行拆单元格。
 * @param {Array<{y:number, fontSize:number, items:Array<{str:string,x:number,width:number}>}>} lines
 *        每行 items 需按 x 升序 (调用方负责归一坐标)
 * @returns {Array<Array<{x:number,text:string}>|null>} 与 lines 等长; 非表格行返回 null
 */
export function buildTableRows(lines, gap = TABLE_CELL_GAP, maxCellChars = TABLE_MAX_CELL_CHARS) {
  return (lines || []).map(ln => {
    const items = (ln && ln.items) || [];
    if (items.length < 2) return null;
    const cells = [];
    let cur = null;
    let prevEnd = -Infinity;
    for (const it of items) {
      const x = Number(it.x) || 0;
      const w = Number(it.width) || 0;
      if (!cur || x - prevEnd >= gap) {
        cur = { x: x, text: '' };
        cells.push(cur);
      }
      cur.text += String(it.str == null ? '' : it.str);
      prevEnd = x + w;
    }
    if (cells.length < 2) return null;
    for (const c of cells) {
      if (c.text.trim().length > maxCellChars) return null; // 长文本行 = 正文
    }
    return cells;
  });
}

/** 列起点跨行对齐: 至少 2 个列位置出现在绝大多数行 */
export function tableColumnsAligned(rows, from, to, minRows = TABLE_MIN_ROWS) {
  const counts = new Map();
  for (let i = from; i <= to; i++) {
    const seen = new Set();
    for (const c of rows[i]) {
      const key = Math.round(c.x / TABLE_COLUMN_TOLERANCE);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const need = Math.min(minRows, to - from + 1);
  let aligned = 0;
  for (const v of counts.values()) if (v >= need) aligned++;
  return aligned >= 2;
}

/**
 * 检测表格段落。
 * @param {Array<{y:number,fontSize:number}>} lines 行信息 (仅用 y/fontSize)
 * @param {Array<Array|null>} rows buildTableRows 结果
 * @param {Array<{lineStart:number,lineEnd:number}>} paragraphs
 * @param {number} minRows
 * @returns {Set<number>} 段落下标集合
 */
export function detectTableParagraphs(lines, rows, paragraphs, minRows = TABLE_MIN_ROWS) {
  const out = new Set();
  if (!Array.isArray(lines) || !Array.isArray(rows) || !Array.isArray(paragraphs)) return out;
  if (lines.length < minRows || !paragraphs.length) return out;
  let i = 0;
  while (i < rows.length) {
    if (!rows[i]) { i++; continue; }
    let j = i;
    while (j + 1 < rows.length && rows[j + 1]) {
      const gapY = Math.abs(lines[j].y - lines[j + 1].y);
      const fs = Math.max(lines[j].fontSize || 12, lines[j + 1].fontSize || 12);
      if (gapY > fs * 2.5) break; // 行距过大 → 另一块
      j++;
    }
    const blockRows = j - i + 1;
    if (blockRows >= minRows && tableColumnsAligned(rows, i, j, minRows)) {
      for (let p = 0; p < paragraphs.length; p++) {
        const s = paragraphs[p].lineStart;
        const e = paragraphs[p].lineEnd;
        let hit = 0;
        for (let k = Math.max(s, i); k <= Math.min(e, j); k++) hit++;
        if (hit >= 2) out.add(p);
      }
    }
    i = j + 1;
  }
  return out;
}
