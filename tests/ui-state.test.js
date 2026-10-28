import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { CONFIG, METRICS } from '../src/config.js';
import * as time from '../src/time.js';
import * as stats from '../src/stats.js';
import { isAccessError } from '../src/feishu.js';
import { createDemoSource } from '../src/demo.js';

class Element {
  constructor(){this.value='';this.checked=false;this.children=[];this.listeners={};this.style={setProperty(){}};this.dataset={};this.open=false;this.hidden=false;this.textContent='';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  addEventListener(name,callback){(this.listeners[name]??=[]).push(callback);}
  async fire(name){for(const callback of this.listeners[name]??[])await callback({});}
  showModal(){this.open=true;}
  close(){this.open=false;this.fire('close');}
  scrollIntoView(){}
}
async function app(storage='{}'){
  const elements=new Map();const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  element('rangeSelect').value='7';
  const charts=[],downloads=[];const fakeSource=createDemoSource();
  const context={console,URL,URLSearchParams,Date,Map,Set,Promise,Intl,CONFIG,METRICS,...time,...stats,isAccessError,
    document:{getElementById:element,createElement:()=>new Element(),querySelectorAll:()=>[],addEventListener(){},hidden:false},
    window:{addEventListener(){}},location:{search:'?demo=1',reload(){}},localStorage:{getItem:()=>storage,setItem(){}},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},
    stockConfig:rows=>({title:'库存',rows}),incomingConfig:rows=>({title:'转入',rows}),
    drawChart:()=>{const chart={destroyed:false,destroy(){this.destroyed=true;}};charts.push(chart);return chart;},
    downloadCsv:(name,rows)=>downloads.push({name,rows}),__fakeSource:fakeSource,
  };
  vm.createContext(context);
  let script=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
  script=script.replace(/^import .*;\r?\n/gm,'');
  script=script.replace(/async function connect\(\) \{[\s\S]*?\n\}/,'async function connect() { globalThis.__invalidate=invalidate; return globalThis.__fakeSource; }');
  script=script.replace(/refresh\(\);\s*$/,'globalThis.__refresh=refresh; globalThis.__done=refresh();');
  vm.runInContext(script,context);await context.__done;
  return{context,element,charts,downloads,fakeSource};
}
test('UI：正常渲染模拟数据，2245去重为1且列出3条原始日志',async()=>{
  const a=await app();assert.equal(a.element('openValue').textContent,38);
  assert.equal(a.element('dailyBody').children.length,7);assert.equal(a.element('detailBody').children.length,1);
  assert.match(a.element('detailSummary').textContent,/1 个 Bug/);
});
test('UI：无效日期+打开放大图时撤销权限，所有旧明细和派生数据立即清除',async()=>{
  const a=await app();await a.element('zoomStock').fire('click');
  a.element('rangeSelect').value='custom';a.element('startDate').value='2026-10-29';a.element('endDate').value='2026-10-27';
  a.context.__invalidate('权限已经撤销');
  assert.equal(a.element('dailyBody').children.length,0);assert.equal(a.element('detailBody').children.length,0);
  assert.equal(a.element('chartDialog').open,false);assert.ok(a.charts.every(c=>c.destroyed));
  assert.equal(a.element('exportDaily').disabled,true);await a.element('exportDaily').fire('click');assert.equal(a.downloads.length,0);
});
test('UI：权限拒绝即使没有通知事件，也清除旧授权数据',async()=>{
  const a=await app();a.fakeSource.loadLogs=async()=>{throw Object.assign(new Error('TablePermissionDeniedError'),{code:10212997});};
  await a.context.__refresh();assert.equal(a.element('dailyBody').children.length,0);assert.equal(a.element('detailBody').children.length,0);
  assert.equal(a.element('fatalError').hidden,false);
});
test('UI：复制权限拒绝不导出，权限异步失效也不导出',async()=>{
  const a=await app();a.fakeSource.canExport=async()=>false;
  await a.element('exportDaily').fire('click');assert.equal(a.downloads.length,0);
  a.fakeSource.canExport=async()=>{a.context.__invalidate('读取权限失效');return true;};
  await a.element('exportDaily').fire('click');assert.equal(a.downloads.length,0);
});
test('UI：本地偏好为null不会阻止启动',async()=>{
  const a=await app('null');assert.equal(a.element('openValue').textContent,38);assert.equal(a.element('fatalError').hidden,true);
});
test('UI：普通读取失败清除对应数据，不让旧放大图继续显示',async()=>{
  const a=await app();await a.element('zoomIncoming').fire('click');a.fakeSource.loadLogs=async()=>{throw new Error('网络超时');};
  await a.context.__refresh();assert.equal(a.element('chartDialog').open,false);assert.equal(a.element('detailBody').children.length,1);
  assert.match(a.element('detailSummary').textContent,/— 个 Bug/);
});
