import test from 'node:test';
import assert from 'node:assert/strict';
import { readAllRecords, withTimeout } from '../src/reader.js';
import { assertFieldTypes, createSourceFromBase, isAccessError } from '../src/feishu.js';
import { requireFields, indexFields } from '../src/cells.js';
import { CONFIG } from '../src/config.js';

const response=(records,total,hasMore=false,pageToken)=>({records,total,hasMore,pageToken});
test('完整读取超过7065行，真实数值游标且每页最多200',async()=>{
  const all=Array.from({length:7127},(_,i)=>({recordId:`rec${i}`,fields:{}}));let pages=0,checked=false;
  const table={async getRecordsByPage({pageSize,pageToken=0}){assert.equal(pageSize,200);assert.equal(typeof pageToken,'number');pages++;return response(all.slice(pageToken,pageToken+pageSize),all.length,pageToken+pageSize<all.length,pageToken+pageSize);}};
  const result=await readAllRecords(table,{checkIdentity:async()=>{checked=true;}});
  assert.equal(result.length,7127);assert.equal(pages,36);assert.equal(checked,true);
});
test('后续pageToken=0合法，不能被当成缺失',async()=>{
  let n=0;const table={async getRecordsByPage(params){if(++n===1)return response([{recordId:'rec1'}],2,true,0);assert.equal(params.pageToken,0);return response([{recordId:'rec2'}],2);}};
  assert.equal((await readAllRecords(table)).length,2);
});
test('中途失败不能返回部分数据',async()=>{
  let n=0;await assert.rejects(readAllRecords({async getRecordsByPage(){if(++n===1)return response([{recordId:'rec1'}],2,true,1);throw new Error('权限失效');}}),/权限失效/);
});
test('重复游标、缺失游标、重复记录均停止',async()=>{
  let n=0;await assert.rejects(readAllRecords({async getRecordsByPage(){return response([{recordId:`rec${++n}`}],5,true,1);}}),/游标/);
  await assert.rejects(readAllRecords({async getRecordsByPage(){return response([],1,true);}}),/游标/);
  await assert.rejects(readAllRecords({async getRecordsByPage(){return response([{recordId:'rec1'},{recordId:'rec1'}],2);}}),/重复/);
});
test('分页期间总数变化、漏行、未知总数不能提交',async()=>{
  let n=0;await assert.rejects(readAllRecords({async getRecordsByPage(){return ++n===1?response([{recordId:'rec1'},{recordId:'rec2'}],4,true,2):response([{recordId:'rec4'}],3);}}),/总行数变化/);
  await assert.rejects(readAllRecords({async getRecordsByPage(){return response([{recordId:'rec1'}],2);}}),/数量与总数/);
  await assert.rejects(readAllRecords({async getRecordsByPage(){return{records:[],hasMore:false};}}),/总行数/);
});
test('拒绝损坏结构与已经取消的扫描',async()=>{
  await assert.rejects(readAllRecords({async getRecordsByPage(){return{records:[],hasMore:'false',total:0};}}),/结构/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(readAllRecords({getRecordsByPage(){throw new Error('不应该调用');}},{signal:controller.signal}),/取消/);
});
test('字段验证拒绝缺字段、重复字段和错误类型',()=>{
  assert.throws(()=>requireFields([],['记录ID']),/缺少/);assert.throws(()=>indexFields([{name:'状态'},{name:'状态'}]),/同名/);
  assert.throws(()=>assertFieldTypes(new Map([['变更时间',{type:1}]]),{'变更时间':[5]}),/类型/);
});
test('读取超时会报错，成功请求返回值',async()=>{
  assert.equal(await withTimeout(Promise.resolve(12),5),12);await assert.rejects(withTimeout(new Promise(()=>{}),5),/超时/);
});
function fakeBase(){
  const handlers=new Map();const installed=[];let baseId=CONFIG.expectedBaseId;
  const install=(scope,method)=>cb=>{const key=`${scope}.${method}`;handlers.set(key,cb);installed.push(key);return()=>handlers.delete(key);};
  const fields=[['rid','记录ID',1],['no','Bug编号',1],['at','变更时间',5],['s','目标状态',3]].map(([id,name,type])=>({id,name,type}));
  const table={getFieldMetaList:async()=>fields,getRecordsByPage:async()=>response([],0)};
  const base={getSelection:async()=>({baseId}),getTableById:async id=>{assert.equal(id,CONFIG.logTableId);return table;},getPermission:async()=>true};
  for(const method of ['onRecordAdd','onRecordDelete','onRecordModify','onFieldAdd','onFieldDelete','onFieldModify'])table[method]=install('table',method);
  for(const method of ['onSelectionChange','onTableDelete','onPermissionChange'])base[method]=install('base',method);
  return{base,table,handlers,installed,setBase:id=>{baseId=id;}};
}
test('适配器在错误Base时失败，不回退到当前表',async()=>{
  const f=fakeBase();f.setBase('wrongBase');await assert.rejects(createSourceFromBase(f.base,()=>{},()=>{}),/身份不匹配/);
});
test('适配器防午夜跨日扫描，不用完成时间制造今日0',async()=>{
  const f=fakeBase();let tick=0;const source=await createSourceFromBase(f.base,()=>{},()=>{},()=>Date.parse(++tick===1?'2026-10-28T23:59:59+08:00':'2026-10-29T00:00:01+08:00'));
  await assert.rejects(source.loadLogs(),/午夜/);source.dispose();
});
test('扫描期间修改任意字段或记录会拒绝本轮，即使不自动刷新',async()=>{
  const f=fakeBase();let notifications=0;const source=await createSourceFromBase(f.base,()=>{notifications++;},()=>{});
  f.table.getRecordsByPage=async()=>{f.handlers.get('table.onRecordModify')({data:{recordId:'recA',fieldIds:['s']}});return response([],0);};
  await assert.rejects(source.loadLogs(),/扫描期间/);assert.equal(notifications,1);source.dispose();
});
test('权限事件单独订阅，不被其它事件订阅失败阻断',async()=>{
  const f=fakeBase();f.base.onSelectionChange=()=>{throw new Error('不支持');};let invalidated=false;
  const source=await createSourceFromBase(f.base,()=>{},()=>{invalidated=true;});
  f.handlers.get('base.onPermissionChange')();assert.equal(invalidated,true);assert.ok(source.warnings.length>0);source.dispose();assert.equal(f.handlers.size,0);
});
test('读取权限拒绝、复制权限未知或拒绝时不能导出',async()=>{
  const f=fakeBase();const source=await createSourceFromBase(f.base,()=>{},()=>{});
  f.base.getPermission=async()=>false;await assert.rejects(source.loadLogs(),/权限/);assert.equal(await source.canExport('details'),false);
  f.base.getPermission=async({type})=>type==='visible';assert.equal(await source.canExport('details'),false);
  f.base.getPermission=async()=>true;assert.equal(await source.canExport('details'),true);source.dispose();
});
test('销毁后的延迟响应不得提交，全部订阅被释放',async()=>{
  const f=fakeBase();let release;const source=await createSourceFromBase(f.base,()=>{},()=>{});
  f.table.getRecordsByPage=()=>new Promise(resolve=>{release=()=>resolve(response([],0));});
  const pending=source.loadLogs();while(!release)await Promise.resolve();source.dispose();release();await assert.rejects(pending,/停止/);assert.equal(f.handlers.size,0);
});
test('识别SDK权限拒绝错误和文本权限错误',()=>{
  for(const code of [10212997,10213997,10214997,10216997])assert.equal(isAccessError({code}),true);
  assert.equal(isAccessError(new Error('permission denied')),true);assert.equal(isAccessError(new Error('网络超时')),false);
});
