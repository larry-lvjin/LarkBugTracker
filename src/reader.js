import { CONFIG } from './config.js';

export async function readAllRecords(table, { signal, onPage, checkIdentity } = {}) {
  const records = [];
  const tokens = new Set();
  const ids = new Set();
  let pageToken;
  let expectedTotal;
  for (let page = 0; page < 10_000; page++) {
    if (signal?.aborted) throw new Error('读取已取消。');
    const request = { pageSize: CONFIG.pageSize };
    if (pageToken !== undefined) request.pageToken = pageToken;
    const response = await withTimeout(table.getRecordsByPage(request));
    if (signal?.aborted) throw new Error('读取已取消。');
    if (!Array.isArray(response?.records) || typeof response.hasMore !== 'boolean') throw new Error('SDK 分页返回结构异常。');
    if (!Number.isSafeInteger(response.total) || response.total < 0) throw new Error('SDK 分页缺少有效总行数。');
    if (expectedTotal === undefined) expectedTotal = response.total;
    if (expectedTotal !== response.total) throw new Error('读取期间总行数变化，本轮混合结果已丢弃，请刷新重试。');
    for (const record of response.records) {
      const id = record.recordId ?? record.record_id;
      if (!id || ids.has(id)) throw new Error('分页记录重复或缺少记录 ID，可能读取期间表发生变化；请重试。');
      ids.add(id);
      records.push(record);
    }
    onPage?.(records.length);
    if (!response.hasMore) {
      if (records.length !== expectedTotal) throw new Error('分页读取数量与总数不一致，本轮结果已丢弃。');
      await checkIdentity?.();
      return records;
    }
    const next = response.pageToken;
    if (next == null || tokens.has(next)) throw new Error('分页游标缺失或重复；已停止，未将部分数据当作完整结果。');
    tokens.add(next);
    pageToken = next;
  }
  throw new Error('读取页数超过安全上限，请缩小数据规模后核对。');
}

export function withTimeout(promise, ms = 20_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('飞书读取超时，请检查网络、权限或是否在插件容器中打开。')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
