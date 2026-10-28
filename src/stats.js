import { CONFIG, METRICS } from './config.js';
import { text, selectText, nonNegativeInteger, fieldValue } from './cells.js';
import { timestamp, dateKey, historyDate, dayStart, daysBetween } from './time.js';

export function currentStock(records, fields) {
  const counts = { total: records.length, unresolved: 0, reopened: 0, pending: 0, emptyStatus: 0 };
  const bugNumbers = new Map();
  const meta = fields.get(CONFIG.fields.bugStatus);
  for (const record of records) {
    const status = selectText(record.fields?.[meta.id], meta);
    if (!status) counts.emptyStatus++;
    for (const metric of METRICS) if (status === metric.status) counts[metric.key]++;
    const number = text(fieldValue(record, fields, CONFIG.fields.bugNo));
    if (number) bugNumbers.set(record.recordId ?? record.record_id, number);
  }
  counts.open = counts.unresolved + counts.reopened;
  return { ...counts, bugNumbers };
}

export function logEvents(records, fields, now = Date.now()) {
  const groups = new Map();
  const firstSeen = {};
  const diagnostics = { rows: records.length, ignoredBlank: 0, ignoredStatus: 0, invalidId: 0, invalidTime: 0, beforeStart: 0, future: 0, accepted: 0, duplicate: 0 };
  const targetMeta = fields.get(CONFIG.fields.targetStatus);
  for (const row of records) {
    const id = text(fieldValue(row, fields, CONFIG.fields.recordId));
    const target = selectText(row.fields?.[targetMeta.id], targetMeta);
    if (!id) { diagnostics.ignoredBlank++; continue; }
    const metric = METRICS.find(item => item.status === target);
    if (!metric) { diagnostics.ignoredStatus++; continue; }
    if (!/^rec[a-zA-Z0-9]+$/.test(id)) { diagnostics.invalidId++; continue; }
    const timeValue = fieldValue(row, fields, CONFIG.fields.changedAt);
    const at = timestamp(typeof timeValue === 'number' ? timeValue : text(timeValue), { requireTime: true });
    if (at === null) { diagnostics.invalidTime++; continue; }
    if (at < Date.parse(metric.start)) { diagnostics.beforeStart++; continue; }
    if (at > now) { diagnostics.future++; continue; }
    diagnostics.accepted++;
    const day = dateKey(at);
    firstSeen[metric.key] = Math.min(firstSeen[metric.key] ?? Infinity, at);
    const groupKey = `${day}|${metric.key}`;
    if (!groups.has(groupKey)) groups.set(groupKey, new Map());
    const bugs = groups.get(groupKey);
    const number = text(fieldValue(row, fields, CONFIG.fields.bugNumber));
    const previous = bugs.get(id);
    if (previous) {
      diagnostics.duplicate++;
      previous.logCount++;
      previous.firstAt = Math.min(previous.firstAt, at);
      previous.lastAt = Math.max(previous.lastAt, at);
      if (number) previous.bugNumbers.add(number);
    } else {
      bugs.set(id, { recordId: id, bugNumbers: new Set(number ? [number] : []), firstAt: at, lastAt: at, logCount: 1 });
    }
  }
  return { groups, firstSeen, diagnostics };
}

export function incomingSeries(logs, start, end, now = Date.now()) {
  const today = dateKey(now);
  return daysBetween(start, end).map(date => ({
    date,
    metrics: Object.fromEntries(METRICS.map(metric => {
      const items = [...(logs?.groups.get(`${date}|${metric.key}`)?.values() ?? [])];
      const since = Date.parse(metric.start);
      let quality;
      if (dayStart(date) > now) quality = 'future';
      else if (date < dateKey(since) || now < since) quality = 'not-covered';
      else if (!logs) quality = 'unavailable';
      else if (!items.length && (!logs.firstSeen[metric.key] || date < dateKey(logs.firstSeen[metric.key]))) quality = 'unverified';
      else if (date === dateKey(since)) quality = 'partial';
      else quality = date === today ? 'today' : 'observed';
      const known = ['partial', 'today', 'observed'].includes(quality);
      return [metric.key, { value: known ? items.length : null, quality, items, since, partial: date === dateKey(since) }];
    })),
  }));
}

export const QUALITY = {
  'not-covered': '未覆盖', unverified: '待验证／暂无日志', unavailable: '读取失败／不可用',
  partial: '首日部分时段', today: '今日截至读取时', observed: '按已读取日志', future: '未来日期',
};

export function historicalStock(records, fields, now = Date.now()) {
  const byDay = new Map();
  const diagnostics = { rows: records.length, invalidDate: 0, invalidValues: 0, duplicate: 0, conflicts: 0 };
  for (const row of records) {
    const rawDate = fieldValue(row, fields, '日期');
    const date = historyDate(typeof rawDate === 'number' ? rawDate : text(rawDate));
    if (!date || date > dateKey(now)) { diagnostics.invalidDate++; continue; }
    const unresolved = nonNegativeInteger(fieldValue(row, fields, '未解决'));
    const reopened = nonNegativeInteger(fieldValue(row, fields, '重新打开'));
    const pending = nonNegativeInteger(fieldValue(row, fields, '待验收'));
    const entry = { date, open: unresolved === null || reopened === null ? null : unresolved + reopened, pending,
      source: 'legacy', conflict: false };
    if (entry.open === null || entry.pending === null) diagnostics.invalidValues++;
    const previous = byDay.get(date);
    if (!previous) byDay.set(date, entry);
    else {
      diagnostics.duplicate++;
      // 无采集时间的同日冲突记录不能擅自选最后一行，也不能相加。
      for (const key of ['open', 'pending']) if (previous[key] !== entry[key]) {
        previous[key] = null;
        previous.conflict = true;
      }
      if (previous.conflict) diagnostics.conflicts++;
    }
  }
  return { byDay, diagnostics };
}

export function stockSeries(history, current, start, end, currentAt, showHistory = true, displayToday = dateKey(Date.now())) {
  return daysBetween(start, end).map(date => {
    if (current && date === displayToday && date === dateKey(currentAt)) return { date, open: current.open, pending: current.pending, source: 'live', at: currentAt };
    const row = showHistory ? history?.byDay.get(date) : null;
    return row ?? { date, open: null, pending: null, source: 'missing' };
  });
}

export function detailRows(day, metricKey, logs, currentNumbers = new Map()) {
  return [...(logs?.groups.get(`${day}|${metricKey}`)?.values() ?? [])].map(item => {
    const numbers = [...item.bugNumbers].sort();
    return { ...item, bugNo: numbers.join(' / ') || currentNumbers.get(item.recordId) || item.recordId,
      numberConflict: numbers.length > 1 };
  }).sort((a, b) => a.bugNo.localeCompare(b.bugNo, 'zh-CN', { numeric: true }));
}
