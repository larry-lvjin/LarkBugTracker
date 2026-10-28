import { CONFIG } from './config.js';
import { requireFields, indexFields } from './cells.js';
import { currentStock, logEvents, historicalStock } from './stats.js';
import { readAllRecords, withTimeout } from './reader.js';
import { dateKey } from './time.js';

export function assertFieldTypes(fields, schema) {
  for (const [name, types] of Object.entries(schema)) {
    const field = fields.get(name);
    if (field && !types.includes(field.type)) throw new Error(`字段「${name}」类型为 ${field.type}，预期 ${types.join('/')}；不会自动修改字段。`);
  }
}
export function isAccessError(error) {
  return [10212997, 10213997, 10214997, 10216997].includes(Number(error?.code)) || /permission|权限|身份不匹配|读取已停止|已失效|不可访问/i.test(error?.message || '');
}

export async function createFeishuSource(onChange, onInvalidate) {
  const { bitable } = await import('@lark-base-open/js-sdk');
  return createSourceFromBase(bitable.base, onChange, onInvalidate);
}

// 可注入假 Base 和时钟做离线集成测试；生产唯一入口只使用官方 SDK。
export async function createSourceFromBase(base, onChange, onInvalidate, clock = Date.now) {
  const disposers = [];
  const tables = new Map();
  const revisions = new Map();
  const warnings = [];
  let disposed = false;
  let historyId;
  const identity = async () => {
    if (disposed) throw new Error('插件读取已停止。');
    const selection = await withTimeout(base.getSelection());
    if (disposed) throw new Error('插件读取已停止。');
    if (!selection?.baseId || selection.baseId !== CONFIG.expectedBaseId) {
      throw new Error(`多维表格身份不匹配：预期 ${CONFIG.expectedBaseId}，实际 ${selection?.baseId ?? '未取得'}。请只读核对配置，不会回退到其他表。`);
    }
  };
  await identity();
  function subscribe(object, method, callback) {
    try {
      if (typeof object[method] !== 'function') throw new Error('宿主不支持');
      disposers.push(object[method](callback));
    } catch { warnings.push(`${method} 订阅不可用；用只读轮询兜底，无法保证扫描期间绝对一致。`); }
  }
  async function tableById(id) {
    if (!tables.has(id)) {
      const table = await withTimeout(base.getTableById(id));
      tables.set(id, table); revisions.set(id, 0);
      for (const method of ['onRecordAdd', 'onRecordDelete', 'onRecordModify', 'onFieldAdd', 'onFieldDelete', 'onFieldModify']) {
        subscribe(table, method, () => {
          if (disposed) return;
          // 无论是否勾选自动刷新，版本都增长，禁止提交混合快照。
          revisions.set(id, (revisions.get(id) ?? 0) + 1);
          onChange();
        });
      }
    }
    return tables.get(id);
  }
  async function visible(id) {
    const allowed = await withTimeout(base.getPermission({ entity: 'Table', type: 'visible', param: { tableId: id } }));
    if (allowed !== true) throw new Error(`目标表 ${id} 的读取权限未获确认。`);
  }
  async function scan(id, required, schema, reduce, onPage, optional = false) {
    await identity(); await visible(id);
    const table = await tableById(id);
    const revision = revisions.get(id);
    const startedAt = clock();
    const metas = await withTimeout(table.getFieldMetaList());
    const fields = optional ? indexFields(metas) : requireFields(metas, required);
    if (optional && !fields.has('日期')) throw new Error('历史表缺少「日期」，不会自动补字段。');
    assertFieldTypes(fields, schema);
    const stable = async () => {
      await identity(); await visible(id);
      if (revisions.get(id) !== revision) throw new Error('扫描期间记录或字段发生变化，本轮结果已丢弃，请刷新重试。');
    };
    const records = await readAllRecords(table, { onPage, checkIdentity: stable });
    const completedAt = clock();
    if (dateKey(startedAt) !== dateKey(completedAt)) throw new Error('读取跨越北京时间午夜，本轮结果已丢弃；请重新刷新以确认新一天的数据。');
    return { data: reduce(records, fields, completedAt), at: startedAt, completedAt, coverageThrough: startedAt, rows: records.length };
  }
  subscribe(base, 'onSelectionChange', ({ data }) => {
    if (!disposed && data?.baseId !== CONFIG.expectedBaseId) onInvalidate('多维表格身份已变化或不可确认，旧结果已清除。');
  });
  for (const method of ['onTableDelete', 'onPermissionChange']) subscribe(base, method, () => {
    if (!disposed) onInvalidate('表结构或权限发生变化，旧结果已清除，请重新连接。');
  });

  return {
    mode: 'feishu', warnings,
    now: clock,
    checkIdentity: identity,
    loadCurrent: onPage => scan(CONFIG.bugTableId, ['问题状态', '序号'], {
      '问题状态': [3], '序号': [1, 2, 1005],
    }, currentStock, onPage),
    loadLogs: onPage => scan(CONFIG.logTableId, ['记录ID', 'Bug编号', '变更时间', '目标状态'], {
      '记录ID': [1], 'Bug编号': [1], '变更时间': [5], '目标状态': [3],
    }, logEvents, onPage),
    async loadHistory(onPage) {
      await identity();
      const list = await withTimeout(base.getTableMetaList());
      const found = list.filter(table => table.name === CONFIG.historyTableName);
      if (found.length !== 1) throw new Error(found.length ? '存在多张同名历史表，无法确定来源。' : '没有找到 BugStats_History；历史存量留空，插件不会建表。');
      historyId = found[0].id;
      return scan(historyId, [], { '日期': [1, 5], '未解决': [1, 2], '重新打开': [1, 2], '待验收': [1, 2] }, historicalStock, onPage, true);
    },
    async canExport(kind, includeHistory = true) {
      await identity();
      const baseCopy = await withTimeout(base.getPermission({ entity: 'Base', type: 'copyable' }));
      if (baseCopy !== true) return false;
      const ids = [CONFIG.bugTableId, CONFIG.logTableId];
      if (kind === 'daily' && includeHistory && historyId) ids.push(historyId);
      for (const id of ids) {
        await visible(id);
        if (await withTimeout(base.getPermission({ entity: 'Table', type: 'copyable', param: { tableId: id } })) !== true) return false;
      }
      await identity();
      return true;
    },
    dispose() {
      disposed = true;
      for (const off of disposers.splice(0)) { try { off?.(); } catch { /* 清理其余订阅 */ } }
      tables.clear(); revisions.clear();
    },
  };
}
