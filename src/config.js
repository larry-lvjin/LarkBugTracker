export const CONFIG = Object.freeze({
  version: '2.0.0',
  title: 'Sigma 耳机 Bug Tracker',
  timeZone: 'Asia/Shanghai',
  baseUrl: 'https://nicebuild.feishu.cn/wiki/TDBEwhwy1ioYaeksG6wcf8Udnkh',
  wikiNodeToken: 'TDBEwhwy1ioYaeksG6wcf8Udnkh',
  bugTableId: 'tbldjYSgIe55Qbcm',
  logTableId: 'tblrtjRhMURlSlOT',
  historyTableName: 'BugStats_History',
  // 对照来源：旧模板。若 SDK 可取得 baseId，必须一致，不自动找别的 Bug 表。
  expectedBaseId: 'E8mgb7Zoxa0ZhLsND7wcOuxKnee',
  pageSize: 200,
  refreshMs: 60_000,
  fields: {
    bugStatus: '问题状态', bugNo: '序号',
    recordId: '记录ID', bugNumber: 'Bug编号', changedAt: '变更时间', targetStatus: '目标状态',
  },
});

// ID 必须是字符串，避免 64 位自动化 ID 被 JavaScript Number 截断。
export const METRICS = Object.freeze([
  { key: 'unresolved', status: '未解决', label: '新增未解决', color: '#e75b65', start: '2026-10-27T23:09:58+08:00', ruleId: '7701362750492118321' },
  { key: 'reopened', status: '重新打开', label: '新增重新打开', color: '#dd931c', start: '2026-10-27T23:09:42+08:00', ruleId: '7701363208913308939' },
  { key: 'pending', status: '待验收', label: '新增待验收', color: '#8b63d9', start: '2026-10-27T23:09:35+08:00', ruleId: '7701363690361163016' },
]);
export const HISTORY_FIELDS = ['日期', '未解决', '重新打开', '待验收'];
