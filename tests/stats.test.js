import test from 'node:test';
import assert from 'node:assert/strict';
import { timestamp, dateKey, addDays, daysBetween, historyDate } from '../src/time.js';
import { text, selectText, nonNegativeInteger, indexFields } from '../src/cells.js';
import { currentStock, logEvents, incomingSeries, historicalStock, stockSeries, detailRows } from '../src/stats.js';
import { CONFIG, METRICS } from '../src/config.js';
import { toCsv } from '../src/export.js';

const now = Date.parse('2026-10-29T12:00:00+08:00');
const logFields = indexFields([
  ['rid','记录ID'], ['no','Bug编号'], ['at','变更时间'], ['target','目标状态'],
].map(([id,name]) => ({ id,name })));
const log = (id, no, target, at) => ({ fields: { rid:id, no, target, at: typeof at === 'string' ? Date.parse(at) : at } });
const example = [
  log('rec2245', '2245', '重新打开', '2026-10-28T08:00:00+08:00'),
  log('rec2245', '2245', '待验收', '2026-10-28T09:00:00+08:00'),
  log('rec2245', '2245', '重新打开', '2026-10-28T10:00:00+08:00'),
  log('rec2245', '2245', '重新打开', '2026-10-28T10:00:00+08:00'),
];

test('北京时间在 UTC 16:00 正确换日，不受本机时区影响', () => {
  assert.equal(dateKey(Date.parse('2026-10-27T15:59:59Z')), '2026-10-27');
  assert.equal(dateKey(Date.parse('2026-10-27T16:00:00Z')), '2026-10-28');
  assert.equal(timestamp('2026-10-28 00:00:00'), Date.parse('2026-10-27T16:00:00Z'));
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.deepEqual(daysBetween('2026-10-27','2026-10-29'), ['2026-10-27','2026-10-28','2026-10-29']);
});
test('拒绝无效日期、模糊日期、秒级时间戳和缺少时间的转入日志', () => {
  for (const value of ['2026-02-30T12:00:00+08:00','2026-13-01','2026-10-27 25:00:00','10/27', 1793112000]) assert.equal(timestamp(value), null);
  assert.equal(timestamp('2026-10-27',{requireTime:true}),null);
  assert.equal(historyDate('2026/10/27'),'2026-10-27');
});
test('文本拼接多段、自动编号保留前导零、单选按本字段元数据映射', () => {
  assert.equal(text([{text:'rec'}, {text:'2245'}]), 'rec2245');
  assert.equal(text({value:'002245',status:'completed'}), '002245');
  assert.equal(text({value:'002245',status:'calculating'}), '');
  assert.equal(selectText({id:'opt1',text:'旧名称'},{property:{options:[{id:'opt1',name:'重新打开'}]}}),'重新打开');
  assert.equal(selectText('opt1',{property:{options:[{id:'opt1',name:'待验收'}]}}),'待验收');
  assert.throws(()=>selectText({id:'unknown',text:'重新打开'},{property:{options:[{id:'opt1',name:'待验收'}]}}),/未知选项/);
});
test('空库存是未知，不是零；无效数字不静默截断', () => {
  assert.equal(nonNegativeInteger(null),null); assert.equal(nonNegativeInteger(''),null);
  assert.equal(nonNegativeInteger(0),0); assert.equal(nonNegativeInteger('12'),12);
  assert.equal(nonNegativeInteger(-1),null); assert.equal(nonNegativeInteger('1.5'),null);
});
test('当前库存只合并未解决和重新打开，待验收不含持续测试', () => {
  const fields = indexFields([{id:'s',name:'问题状态'},{id:'n',name:'序号'}]);
  const rows = ['未解决','重新打开','待验收','已回归，持续测试','未复现，持续测试','已关闭'].map((status,i)=>({recordId:`rec${i}`,fields:{s:{text:status},n:{value:`00${i}`,status:'completed'}}}));
  const result=currentStock(rows,fields); assert.equal(result.open,2); assert.equal(result.pending,1); assert.equal(result.total,6);
  assert.equal(result.bugNumbers.get('rec1'),'001');
});
test('2245 当天转入后又转走仍计入，重复日志和重复转入均按 Bug 去重', () => {
  const logs=logEvents(example,logFields,now); const row=incomingSeries(logs,'2026-10-28','2026-10-28',now)[0];
  assert.equal(row.metrics.reopened.value,1); assert.equal(row.metrics.pending.value,1);
  assert.equal(logs.diagnostics.duplicate,2);
  const details=detailRows('2026-10-28','reopened',logs);
  assert.equal(details[0].bugNo,'2245'); assert.equal(details[0].logCount,3);
});
test('不同记录具有相同业务编号仍计两个Bug，跨日期分别去重', () => {
  const logs=logEvents([...example,log('recAnother','2245','重新打开','2026-10-28T11:00:00+08:00'),log('rec2245','2245','重新打开','2026-10-29T08:00:00+08:00')],logFields,now);
  const rows=incomingSeries(logs,'2026-10-28','2026-10-29',now);
  assert.equal(rows[0].metrics.reopened.value,2); assert.equal(rows[1].metrics.reopened.value,1);
});
test('空说明行、非法ID、非法时间、未知状态、未来日志不计入', () => {
  const logs=logEvents([{fields:{}},log('2245','2245','重新打开',now),log('recBad','','重新打开',NaN),log('recOther','','持续测试',now),log('recFuture','','待验收',now+1000)],logFields,now);
  assert.equal(logs.diagnostics.accepted,0); assert.equal(logs.diagnostics.ignoredBlank,1); assert.equal(logs.diagnostics.invalidId,1); assert.equal(logs.diagnostics.invalidTime,1); assert.equal(logs.diagnostics.future,1);
});
test('精确应用各条规则启用时间，不能统一截到23:09:00', () => {
  const logs=logEvents([
    log('recA','1','未解决','2026-10-27T23:09:57+08:00'),
    log('recB','2','未解决','2026-10-27T23:09:58+08:00'),
    log('recC','3','重新打开','2026-10-27T23:09:41+08:00'),
    log('recD','4','重新打开','2026-10-27T23:09:42+08:00'),
    log('recE','5','待验收','2026-10-27T23:09:35+08:00'),
  ],logFields,now);
  assert.equal(logs.diagnostics.beforeStart,2);
  const cells=incomingSeries(logs,'2026-10-27','2026-10-27',now)[0].metrics;
  for (const m of METRICS) { assert.equal(cells[m.key].value,1); assert.equal(cells[m.key].quality,'partial'); }
});
test('采集前、没有首条日志及首条日志前日期为未知，而不是伪造零', () => {
  const empty=logEvents([],logFields,now);
  const rows=incomingSeries(empty,'2026-10-26','2026-10-29',now);
  assert.equal(rows[0].metrics.reopened.quality,'not-covered');
  for (const row of rows) assert.equal(row.metrics.reopened.value,null);
  const logs=logEvents(example,logFields,now);
  assert.equal(incomingSeries(logs,'2026-10-27','2026-10-27',now)[0].metrics.reopened.value,null);
  assert.equal(incomingSeries(logs,'2026-10-29','2026-10-29',now)[0].metrics.reopened.value,0);
});
test('没有日志来源、未来日期都不输出零', () => {
  assert.equal(incomingSeries(null,'2026-10-28','2026-10-28',now)[0].metrics.pending.quality,'unavailable');
  assert.equal(incomingSeries(null,'2026-10-30','2026-10-30',now)[0].metrics.pending.quality,'future');
});
test('不依赖当前主表集合：已经关闭/删除的Bug仍保留真实转入明细', () => {
  assert.equal(detailRows('2026-10-28','reopened',logEvents(example,logFields,now),new Map()).length,1);
});
test('业务编号缺失回退当前映射，再回退来源ID；编号矛盾显式标记', () => {
  const logs=logEvents([log('recA','','待验收','2026-10-28T10:00:00+08:00'),log('recB','1','待验收','2026-10-28T10:00:00+08:00'),log('recB','2','待验收','2026-10-28T11:00:00+08:00')],logFields,now);
  const rows=detailRows('2026-10-28','pending',logs,new Map([['recA','003']]));
  assert.ok(rows.some(row=>row.bugNo==='003'));
  assert.ok(rows.find(row=>row.recordId==='recB').numberConflict);
});
const hf=indexFields(['日期','未解决','重新打开','待验收'].map((name,i)=>({id:`h${i}`,name})));
const historyRow=(date,u,r,p)=>({fields:{h0:date,h1:u,h2:r,h3:p}});
test('历史库存缺列/缺值保留null，零值有效，同日不累加', () => {
  const result=historicalStock([historyRow('2026-10-27',10,2,0),historyRow('2026-10-27',10,2,0),historyRow('2026-10-28',null,3,5)],hf,now);
  assert.equal(result.byDay.get('2026-10-27').open,12); assert.equal(result.byDay.get('2026-10-27').pending,0);
  assert.equal(result.byDay.get('2026-10-28').open,null); assert.equal(result.byDay.get('2026-10-28').pending,5);
});
test('同日历史冲突不任选最后一行，也不相加', () => {
  const result=historicalStock([historyRow('2026-10-27',10,2,5),historyRow('2026-10-27',20,2,5)],hf,now);
  assert.equal(result.byDay.get('2026-10-27').open,null); assert.equal(result.byDay.get('2026-10-27').pending,5);
});
test('今天主表值覆盖当天旧历史，其它缺失日期不延续前值', () => {
  const history=historicalStock([historyRow('2026-10-27',10,2,5),historyRow('2026-10-29',99,1,1)],hf,now);
  const rows=stockSeries(history,{open:8,pending:4},'2026-10-27','2026-10-29',now,true,'2026-10-29');
  assert.equal(rows[0].open,12); assert.equal(rows[1].open,null); assert.equal(rows[2].open,8); assert.equal(rows[2].source,'live');
  assert.equal(stockSeries(history,{open:8,pending:4},'2026-10-27','2026-10-29',now,false)[0].open,null);
});
test('CSV 防公式注入、逗号换行转义，未知值保留空格而非0', () => {
  const csv=toCsv([['=HYPERLINK("bad")',null,'2245','a,b','line\nnext']]);
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes(',"",')); assert.ok(csv.includes('"a,b"'));
});
test('自动化ID保持字符串且每条启用时间独立', () => {
  for (const metric of METRICS) assert.equal(typeof metric.ruleId,'string');
  assert.equal(new Set(METRICS.map(m=>m.start)).size,3);
  assert.equal(CONFIG.logTableId,'tblrtjRhMURlSlOT');
});
test('昨日主表缓存不覆盖昨日历史、不制造历史点', () => {
  const yesterday=Date.parse('2026-10-28T23:59:59+08:00');
  const history=historicalStock([historyRow('2026-10-28',90,10,20)],hf,now);
  const rows=stockSeries(history,{open:10,pending:2},'2026-10-28','2026-10-29',yesterday,true,'2026-10-29');
  assert.equal(rows[0].open,100);assert.equal(rows[0].source,'legacy');assert.equal(rows[1].open,null);
  assert.equal(stockSeries(null,{open:10,pending:2},'2026-10-28','2026-10-29',yesterday,true,'2026-10-29')[0].open,null);
});
test('富文本仅整体trim，不把内部含空格的非法ID变成合法ID', () => {
  assert.equal(text([{text:'rec '},{text:'A'}]),'rec A');
  const logs=logEvents([{fields:{rid:[{text:'rec '},{text:'A'}],no:'1',target:'重新打开',at:now}}],logFields,now);
  assert.equal(logs.diagnostics.invalidId,1);
});
