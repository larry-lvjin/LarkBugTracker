import { CONFIG, METRICS } from './config.js';
import { indexFields } from './cells.js';
import { currentStock, logEvents, historicalStock } from './stats.js';

// 明示演示模式才加载本模块。不会导入飞书 SDK，也不会发出任何飞书数据请求。
export function createDemoSource() {
  const now = Date.parse('2026-10-28T16:30:00+08:00');
  const bugFields = indexFields([
    { id: 'status', name: '问题状态', type: 3 }, { id: 'number', name: '序号', type: 1005 },
  ]);
  const bugs = Array.from({ length: 156 }, (_, i) => ({ recordId: `recDemo${i}`, fields: {
    status: { id: '', text: i < 30 ? '未解决' : i < 38 ? '重新打开' : i < 61 ? '待验收' : '已关闭' },
    number: { value: String(2200 + i), status: 'completed' },
  } }));
  bugs[45].fields.number.value = '2245';
  const fields = indexFields([
    { id: 'rid', name: CONFIG.fields.recordId, type: 1 },
    { id: 'no', name: CONFIG.fields.bugNumber, type: 1 },
    { id: 'at', name: CONFIG.fields.changedAt, type: 5 },
    { id: 'target', name: CONFIG.fields.targetStatus, type: 3 },
  ]);
  const rawLogs = Array.from({ length: 10 }, (_, i) => ({ recordId: `recBlank${i}`, fields: {} }));
  function event(id, number, target, at) {
    rawLogs.push({ recordId: `recLog${rawLogs.length}`, fields: {
      rid: [{ type: 'text', text: id }], no: [{ type: 'text', text: number }],
      at: Date.parse(at), target: { id: '', text: target },
    } });
  }
  for (const metric of METRICS) {
    event(`recStart${metric.key}`, '2230', metric.status, '2026-10-27T23:20:00+08:00');
  }
  event('recDemo45', '2245', '重新打开', '2026-10-28T09:15:00+08:00');
  event('recDemo45', '2245', '待验收', '2026-10-28T12:00:00+08:00');
  event('recDemo45', '2245', '重新打开', '2026-10-28T15:30:00+08:00');
  event('recDemo45', '2245', '重新打开', '2026-10-28T15:30:00+08:00');
  event('recDemo12', '2212', '未解决', '2026-10-28T10:30:00+08:00');
  event('recDemo15', '2215', '未解决', '2026-10-28T11:30:00+08:00');
  const hf = indexFields(['日期', '未解决', '重新打开', '待验收'].map((name, i) => ({ id: `h${i}`, name, type: i === 0 ? 1 : 2 })));
  const history = Array.from({ length: 10 }, (_, i) => ({ recordId: `recH${i}`, fields: {
    h0: `2026-10-${String(18 + i).padStart(2, '0')}`, h1: 44 - i, h2: 6 + i % 3, h3: 14 + i,
  } }));
  const wrap = (data, rows) => Promise.resolve({ data, rows, at: now });
  return {
    mode: 'demo', now: () => now, checkIdentity: async () => {}, canExport: async () => true, warnings: [], dispose() {},
    loadCurrent: () => wrap(currentStock(bugs, bugFields), bugs.length),
    loadLogs: () => wrap(logEvents(rawLogs, fields, now), rawLogs.length),
    loadHistory: () => wrap(historicalStock(history, hf, now), history.length),
  };
}
