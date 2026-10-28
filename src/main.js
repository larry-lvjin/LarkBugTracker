import './style.css';
import { CONFIG, METRICS } from './config.js';
import { dateKey, addDays, validDateKey, daysBetween, formatTime } from './time.js';
import { incomingSeries, stockSeries, detailRows, QUALITY } from './stats.js';
import { drawChart, stockConfig, incomingConfig } from './charts.js';
import { downloadCsv } from './export.js';
import { isAccessError, createFeishuSource } from './feishu.js';

const $ = id => document.getElementById(id);
const demo = new URLSearchParams(location.search).get('demo') === '1';
const slots = Object.fromEntries(['current', 'logs', 'history'].map(key => [key, { result: null, error: null }]));
let source, busy = false, dirty = false, generation = 0, disposed = false, debounceTimer, pollTimer;
let stockChart, flowChart, zoomChart, chartData, flowRows = [], stockRows = [], detailPage = 0;
const PAGE_SIZE = 30;
const saved = (() => { try { const value = JSON.parse(localStorage.getItem('sigma-readonly-display-v2') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } })();
if (['7', '30', '90', 'all'].includes(saved.range)) $('rangeSelect').value = saved.range;
$('showHistory').checked = saved.showHistory !== false;
$('autoRefresh').checked = saved.autoRefresh !== false;
$('demoBanner').hidden = !demo;
$('sourceLink').href = CONFIG.baseUrl;
for (const metric of METRICS) {
  const option = document.createElement('option'); option.value = metric.key; option.textContent = metric.status; $('detailMetric').append(option);
  const item = document.createElement('div'); item.textContent = `${metric.label}：${formatTime(Date.parse(metric.start))} 起 · 规则 ${metric.ruleId}`; $('ruleInfo').append(item);
}
$('detailMetric').value = 'reopened';
function node(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
function preference() {
  try { localStorage.setItem('sigma-readonly-display-v2', JSON.stringify({ range: $('rangeSelect').value, showHistory: $('showHistory').checked, autoRefresh: $('autoRefresh').checked })); } catch { /* 隐私模式下也可以使用。 */ }
}
const now = () => source?.now() ?? Date.now();
function range() {
  const end = dateKey(now());
  const choice = $('rangeSelect').value;
  if (choice === 'custom') {
    const start = $('startDate').value, finish = $('endDate').value;
    if (!validDateKey(start) || !validDateKey(finish) || start > finish || finish > end) throw new Error('请输入有效日期：开始不晚于结束，结束不晚于今天。');
    if (daysBetween(start, finish).length > 1096) throw new Error('自定义范围最多为 3 年，请分段查看。');
    return [start, finish];
  }
  if (choice === 'all') {
    const dates = [end, ...METRICS.map(m => dateKey(Date.parse(m.start))).filter(date => date <= end)];
    if ($('showHistory').checked) dates.push(...(slots.history.result?.data.byDay.keys() ?? []));
    const first = dates.sort()[0];
    return [first < addDays(end, -1095) ? addDays(end, -1095) : first, end];
  }
  return [addDays(end, -(Number(choice) - 1)), end];
}
function logSeries(start, end) {
  const rows = incomingSeries(slots.logs.result?.data, start, end, now());
  const readDay = slots.logs.result ? dateKey(slots.logs.result.at) : null;
  // 跨日的旧缓存不能制造今天的零值。
  if (readDay) for (const row of rows) if (row.date > readDay) for (const cell of Object.values(row.metrics)) { cell.value = null; cell.quality = 'unavailable'; }
  return rows;
}
function renderCards() {
  const current = slots.current.result;
  $('openValue').textContent = current?.data.open ?? '—';
  $('pendingValue').textContent = current?.data.pending ?? '—';
  $('openBreakdown').textContent = current ? `未解决 ${current.data.unresolved} · 重新打开 ${current.data.reopened} · 全表 ${current.data.total}${slots.current.error ? '（上次成功值）' : ''}` : '主表读取不可用；不会显示为 0';
  $('todayLabel').textContent = dateKey(now());
  const today = logSeries(dateKey(now()), dateKey(now()))[0];
  $('incomingCards').replaceChildren(...METRICS.map(metric => {
    const cell = today.metrics[metric.key];
    const button = node('button', null, 'incoming-card'); button.type = 'button'; button.style.setProperty('--metric-color', metric.color);
    button.append(node('span', metric.label, 'label'), node('strong', cell.value ?? '—'), node('span', `${QUALITY[cell.quality]}${slots.logs.error ? ' · 缓存' : ''}`, 'hint'));
    button.addEventListener('click', () => selectDetails(today.date, metric.key)); return button;
  }));
  const d = slots.logs.result?.data.diagnostics;
  const noFirst = METRICS.filter(metric => !slots.logs.result?.data.firstSeen[metric.key]).map(metric => metric.status);
  const pieces = ['采集起点：2026-10-27 23:09（首日部分时段）。按北京时间、目标状态和记录 ID 去重。'];
  if (slots.logs.error) pieces.push(`日志读取失败：${slots.logs.error} ${slots.logs.result ? '当前显示上次成功读取的数据。' : ''}`);
  else if (noFirst.length) pieces.push(`尚未观察到首条有效日志：${noFirst.join('、')}。启用报告不等同于运行成功。`);
  else pieces.push('三个目标均已观察到日志；自动化连续运行完整性仍未独立验证。');
  if (d) {
    pieces.push(`扫描 ${d.rows} 行，有效日志 ${d.accepted} 条，日内同 Bug 同状态多余日志 ${d.duplicate} 条。`);
    const bad = d.invalidId + d.invalidTime + d.future;
    if (bad) pieces.push(`有 ${bad} 条异常记录被排除，请在“说明”中核对。`);
  }
  $('coverageNotice').textContent = pieces.join(' ');
}
function render() {
  if ($('chartDialog').open) $('chartDialog').close();
  renderCards(); renderDiagnostics();
  let start, end;
  try { [start, end] = range(); $('rangeError').hidden = true; }
  catch (error) { clearSensitiveState(); $('rangeError').hidden = false; $('rangeError').textContent = error.message; return; }
  stockRows = stockSeries(slots.history.result?.data, slots.current.result?.data, start, end, slots.current.result?.at, $('showHistory').checked, dateKey(now()));
  flowRows = logSeries(start, end);
  chartData = { stock: stockConfig(stockRows), incoming: incomingConfig(flowRows) };
  stockChart?.destroy(); flowChart?.destroy();
  stockChart = drawChart($('stockChart'), chartData.stock);
  flowChart = drawChart($('incomingChart'), chartData.incoming, (date, index) => selectDetails(date, METRICS[index].key));
  $('stockEmpty').hidden = stockRows.some(row => row.open !== null || row.pending !== null);
  $('incomingEmpty').hidden = flowRows.some(row => METRICS.some(m => row.metrics[m.key].value !== null));
  $('stockCaption').textContent = `${start} 至 ${end} · 主表${slots.current.error ? '缓存' : '当前'}读取 + 已有历史表；缺失不补零。`;
  if (!$('detailDate').value) $('detailDate').value = end;
  $('detailDate').max = dateKey(now());
  renderDetails(); renderDaily();
  const stamps = Object.entries(slots).filter(([, slot]) => slot.result).map(([key, slot]) => `${{ current: '主表', logs: '日志', history: '历史' }[key]} ${formatTime(slot.result.at)}${slot.error ? '（旧）' : ''}`);
  $('updatedAt').textContent = stamps.join(' · ') || '尚无成功读取';
}
function selectDetails(day, key) {
  $('detailDate').value = day; $('detailMetric').value = key; $('detailSearch').value = ''; detailPage = 0;
  renderDetails(); $('detailsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function filteredDetails() {
  const query = $('detailSearch').value.trim().toLowerCase();
  return detailRows($('detailDate').value, $('detailMetric').value, slots.logs.result?.data, slots.current.result?.data.bugNumbers)
    .filter(row => !query || row.recordId.toLowerCase().includes(query) || row.bugNo.toLowerCase().includes(query));
}
function renderDetails() {
  const date = $('detailDate').value;
  if (!validDateKey(date)) return;
  const metric = METRICS.find(m => m.key === $('detailMetric').value);
  const cell = logSeries(date, date)[0].metrics[metric.key];
  const rows = filteredDetails();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); detailPage = Math.min(detailPage, pages - 1);
  $('detailSummary').textContent = `${date} · ${metric.status}：${cell.value ?? '—'} 个 Bug · ${QUALITY[cell.quality]}${slots.logs.error ? ' · 显示旧缓存' : ''}`;
  $('detailBody').replaceChildren();
  if (!rows.length) {
    const tr = node('tr', null, 'empty-row'); const td = node('td', cell.value === null ? '该日期暂无可确认数据，不代表没有发生状态变化。' : '已读取的日志中没有匹配项。'); td.colSpan = 4; tr.append(td); $('detailBody').append(tr);
  }
  for (const row of rows.slice(detailPage * PAGE_SIZE, (detailPage + 1) * PAGE_SIZE)) {
    const tr = node('tr'); const first = node('td');
    if (!demo) {
      const link = node('a', `${row.bugNo} ↗`); const url = new URL(CONFIG.baseUrl); url.searchParams.set('table', CONFIG.bugTableId); url.searchParams.set('record', row.recordId);
      link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; first.append(link);
    } else first.append(node('span', row.bugNo));
    first.append(node('small', `${row.recordId}${row.numberConflict ? ' · 日志编号不一致，请核对' : ''}`));
    tr.append(first, node('td', formatTime(row.firstAt)), node('td', formatTime(row.lastAt)), node('td', String(row.logCount))); $('detailBody').append(tr);
  }
  $('detailPageInfo').textContent = `${rows.length} 个匹配 Bug · 第 ${detailPage + 1}/${pages} 页`;
  $('prevDetails').disabled = detailPage === 0; $('nextDetails').disabled = detailPage + 1 >= pages;
  $('exportDetails').disabled = rows.length === 0;
}
function stockOrigin(row) { return row.source === 'live' ? '主表读取值' : row.source === 'legacy' ? (row.conflict ? '历史冲突' : '旧历史表，时点未验证') : '缺失'; }
function renderDaily() {
  $('exportDaily').disabled = !source || !Object.values(slots).some(slot => slot.result) || !stockRows.length;
  $('dailyBody').replaceChildren(...stockRows.map((stock, index) => {
    const tr = node('tr'); tr.append(node('td', stock.date), node('td', stock.open ?? '—'), node('td', stock.pending ?? '—'));
    for (const metric of METRICS) { const cell = flowRows[index].metrics[metric.key]; const td = node('td', cell.value ?? '—'); td.append(node('small', QUALITY[cell.quality])); tr.append(td); }
    tr.append(node('td', stockOrigin(stock))); return tr;
  }).reverse());
}
function renderDiagnostics() {
  $('sourceInfo').replaceChildren();
  for (const warning of source?.warnings ?? []) $('sourceInfo').append(node('p', warning, 'inline-error'));
  const labels = { current: `Bug 主表 · ${CONFIG.bugTableId}`, logs: `StatusChanges · ${CONFIG.logTableId}`, history: 'BugStats_History（可选）' };
  for (const [key, slot] of Object.entries(slots)) {
    const div = node('div', null, 'source-item'); div.append(node('strong', labels[key]));
    div.append(node('p', slot.result ? `上次成功：${formatTime(slot.result.at)} · 完整读取 ${slot.result.rows} 行` : '尚未成功读取'));
    if (slot.error) div.append(node('p', `错误：${slot.error}`));
    const d = slot.result?.data.diagnostics;
    if (d) div.append(node('p', Object.entries(d).map(([k, v]) => `${({ rows:'扫描行数', ignoredBlank:'说明/空记录', ignoredStatus:'非目标状态', invalidId:'无效来源ID', invalidTime:'无效时间', beforeStart:'启用前日志', future:'未来时间', accepted:'有效日志', duplicate:'重复/多次日志', invalidDate:'无效日期', invalidValues:'缺失/无效库存', conflicts:'同日库存冲突' })[k] || k} ${v}`).join(' · ')));
    $('sourceInfo').append(div);
  }
}
function scheduleReload() {
  if (disposed || !$('autoRefresh').checked) return;
  dirty = true;
  if (document.hidden || busy) return;
  clearTimeout(debounceTimer); debounceTimer = setTimeout(() => refresh(), 1200);
}
function clearSensitiveState() {
  stockRows = []; flowRows = []; chartData = null;
  stockChart?.destroy(); flowChart?.destroy(); zoomChart?.destroy();
  stockChart = null; flowChart = null; zoomChart = null;
  if ($('chartDialog').open) $('chartDialog').close();
  $('dailyBody').replaceChildren(); $('detailBody').replaceChildren();
  $('detailSummary').textContent = '数据已清除，请重新读取。';
  $('detailPageInfo').textContent = '';
  $('updatedAt').textContent = '数据已清除';
  $('exportDetails').disabled = true; $('exportDaily').disabled = true;
  $('stockEmpty').hidden = false; $('incomingEmpty').hidden = false;
}
function invalidate(reason) {
  generation++; source?.dispose(); source = null; dirty = false;
  for (const slot of Object.values(slots)) { slot.result = null; slot.error = reason; }
  clearSensitiveState();
  $('fatalError').hidden = false; $('fatalError').textContent = reason; renderCards(); renderDiagnostics();
}
async function connect() {
  if (demo) { const { createDemoSource } = await import('./demo.js'); return createDemoSource(); }
  return createFeishuSource(scheduleReload, invalidate);
}
async function refresh() {
  if (disposed) return;
  if (busy) { dirty = true; return; }
  busy = true; dirty = false; $('refreshBtn').disabled = true;
  const epoch = generation;
  $('loadStatus').className = 'load-status'; $('loadStatus').textContent = '正在完整读取主表、状态日志与历史库存…';
  try {
    if (!source) {
      const connected = await connect();
      if (epoch !== generation || disposed) { connected.dispose(); return; }
      source = connected;
    }
    if (epoch !== generation || disposed) return;
    await source.checkIdentity(); $('fatalError').hidden = true;
    await Promise.all(Object.entries({ current: 'loadCurrent', logs: 'loadLogs', history: 'loadHistory' }).map(async ([key, method]) => {
      try {
        const result = await source[method]();
        if (epoch !== generation || disposed) return;
        slots[key] = { result, error: null };
      } catch (error) {
        if (epoch !== generation || disposed) return;
        if (isAccessError(error)) { invalidate(error.message || '读取权限失效'); return; }
        slots[key] = { result: null, error: error.message || String(error) };
      }
    }));
    if (epoch !== generation || disposed) return;
    await source.checkIdentity();
    render();
    const errors = Object.values(slots).filter(slot => slot.error).length;
    $('loadStatus').textContent = errors ? `${errors} 个来源不可用或存在错误；缺失不补零，缓存带时间标记。详见“说明”。` : `${demo ? '演示数据' : '完整分页读取完成'} · 自动刷新 ${$('autoRefresh').checked ? '开启（60 秒）' : '关闭'}`;
    $('loadStatus').className = `load-status${errors ? ' error' : ''}`;
  } catch (error) {
    if (epoch !== generation || disposed) return;
    invalidate(error.message || String(error));
    $('loadStatus').textContent = '连接失败。请在正确的飞书插件容器打开；本地预览请明确使用 ?demo=1。';
  } finally {
    busy = false; $('refreshBtn').disabled = false;
    if (dirty && !disposed && !document.hidden && $('autoRefresh').checked) { clearTimeout(debounceTimer); debounceTimer = setTimeout(refresh, 1500); }
  }
}
function showZoom(kind) {
  if (!chartData) return;
  $('zoomTitle').textContent = chartData[kind].title; $('chartDialog').showModal();
  zoomChart?.destroy(); zoomChart = drawChart($('zoomChart'), chartData[kind], kind === 'incoming' ? (date, index) => { $('chartDialog').close(); selectDetails(date, METRICS[index].key); } : undefined);
}
$('refreshBtn').addEventListener('click', refresh);
$('aboutBtn').addEventListener('click', () => { renderDiagnostics(); $('aboutDialog').showModal(); });
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
$('chartDialog').addEventListener('close', () => { zoomChart?.destroy(); zoomChart = null; });
$('zoomStock').addEventListener('click', () => showZoom('stock')); $('zoomIncoming').addEventListener('click', () => showZoom('incoming'));
$('rangeSelect').addEventListener('change', () => {
  $('customRange').hidden = $('rangeSelect').value !== 'custom';
  if (!$('startDate').value) { $('startDate').value = addDays(dateKey(now()), -29); $('endDate').value = dateKey(now()); }
  preference(); render();
});
$('applyRange').addEventListener('click', render);
$('showHistory').addEventListener('change', () => { preference(); render(); });
$('autoRefresh').addEventListener('change', () => { preference(); if ($('autoRefresh').checked) scheduleReload(); });
for (const id of ['detailDate', 'detailMetric', 'detailSearch']) $(id).addEventListener(id === 'detailSearch' ? 'input' : 'change', () => { detailPage = 0; renderDetails(); });
$('prevDetails').addEventListener('click', () => { detailPage--; renderDetails(); }); $('nextDetails').addEventListener('click', () => { detailPage++; renderDetails(); });
async function exportAllowed(kind, perform) {
  const epoch = generation;
  if (!source) return;
  try {
    const allowed = await source.canExport(kind, $('showHistory').checked && Boolean(slots.history.result));
    if (epoch !== generation || disposed || !source) return;
    if (allowed !== true) { $('loadStatus').textContent = '未确认飞书复制/导出权限，已阻止导出。不会绕过权限设置。'; return; }
    perform();
  } catch (error) {
    if (epoch !== generation || disposed) return;
    if (isAccessError(error)) invalidate(error.message);
    else $('loadStatus').textContent = `无法核验导出权限，未下载：${error.message}`;
  }
}
$('exportDetails').addEventListener('click', () => exportAllowed('details', () => downloadCsv(`bug-transitions-${$('detailDate').value}-${$('detailMetric').value}${demo ? '-DEMO' : ''}.csv`, [
  ['日期', '目标状态', 'Bug编号', '来源记录ID', '首次转入(北京时间)', '最后日志(北京时间)', '日志条数', '去重计数', '日志读取时间', '是否旧缓存'],
  ...filteredDetails().map(row => [$('detailDate').value, METRICS.find(m => m.key === $('detailMetric').value).status, row.bugNo, row.recordId, formatTime(row.firstAt), formatTime(row.lastAt), row.logCount, 1, formatTime(slots.logs.result?.at), Boolean(slots.logs.error)]),
])));
$('exportDaily').addEventListener('click', () => exportAllowed('daily', () => downloadCsv(`bug-daily-${dateKey(now())}${demo ? '-DEMO' : ''}.csv`, [
  ['日期', '未解决+重新打开', '待验收', '存量来源', ...METRICS.flatMap(m => [m.label, `${m.label}数据口径`]), '日志读取时间', '日志缓存状态'],
  ...stockRows.map((stock, index) => [stock.date, stock.open, stock.pending, stockOrigin(stock), ...METRICS.flatMap(m => { const c = flowRows[index].metrics[m.key]; return [c.value, QUALITY[c.quality]]; }), formatTime(slots.logs.result?.at), slots.logs.error ? '读取失败的旧缓存' : '本轮读取']),
])));
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('autoRefresh').checked) scheduleReload(); });
pollTimer = setInterval(() => { if (!document.hidden && $('autoRefresh').checked && source) refresh(); }, CONFIG.refreshMs);
window.addEventListener('pagehide', () => { disposed = true; generation++; clearInterval(pollTimer); clearTimeout(debounceTimer); source?.dispose(); stockChart?.destroy(); flowChart?.destroy(); zoomChart?.destroy(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
refresh();
