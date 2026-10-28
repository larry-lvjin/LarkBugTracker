import { CONFIG } from './config.js';

const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: CONFIG.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function dateKey(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + OFFSET).toISOString().slice(0, 10);
}
export function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}
export function dayStart(day) { return validDateKey(day) ? Date.parse(`${day}T00:00:00+08:00`) : NaN; }
export function addDays(day, delta) { return dateKey(dayStart(day) + delta * DAY); }
export function daysBetween(start, end) {
  if (!validDateKey(start) || !validDateKey(end) || start > end) return [];
  const length = Math.floor((dayStart(end) - dayStart(start)) / DAY) + 1;
  if (length > 3660) throw new Error('日期范围不能超过 10 年。');
  return Array.from({ length }, (_, index) => addDays(start, index));
}
export function formatTime(ms) { return Number.isFinite(ms) ? formatter.format(ms) : '—'; }

// 日期字段读取值为毫秒时间戳。兼容明确时区 ISO 和北京时间文本，不采用本机时区。
export function timestamp(value, { requireTime = false } = {}) {
  if (typeof value === 'number') return value >= 946656000000 && value < 7258089600000 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^\d{13}$/.test(s)) return timestamp(Number(s));
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (!match || (requireTime && !match[4])) return null;
  const [, y, mo, d, h = '00', mi = '00', sec = '00', frac = '', tz = '+08:00'] = match;
  if (!validDateKey(`${y}-${mo}-${d}`) || +h > 23 || +mi > 59 || +sec > 59) return null;
  const parsed = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}${frac}${tz}`);
  return Number.isFinite(parsed) ? parsed : null;
}
export function historyDate(value) {
  if (typeof value === 'string') {
    const normalized = value.trim().replaceAll('/', '-');
    if (validDateKey(normalized)) return normalized;
  }
  const ms = timestamp(value);
  return ms === null ? null : dateKey(ms);
}
