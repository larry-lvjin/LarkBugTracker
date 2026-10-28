export function csvCell(value) {
  let str = value == null ? '' : String(value);
  // 防止 Bug 编号、外部单元格内容在 Excel 中被当作公式执行。
  if (/^[\s]*[=+@-]/.test(str) || /^[\t\r\n]/.test(str)) str = `'${str}`;
  return `"${str.replaceAll('"', '""')}"`;
}
export function toCsv(rows) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'); }
export function downloadCsv(filename, rows) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
