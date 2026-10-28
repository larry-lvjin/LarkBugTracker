import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// 只服务本地 dist、独立浏览器配置目录。无飞书登录、无真实表格请求。
const root=resolve('dist');
await stat(resolve(root,'index.html'));
await mkdir('artifacts',{recursive:true});
const server=createServer(async(req,res)=>{
  try{
    const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=resolve(root,`.${path==='/'?'/index.html':path}`);
    if(!file.startsWith(root+sep)){res.writeHead(403).end();return;}
    const data=await readFile(file);
    res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'})[extname(file)]||'application/octet-stream'});res.end(data);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
let context;
try{
  context=await chromium.launchPersistentContext(resolve('artifacts/browser-profile'),{
    channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true,viewport:{width:1180,height:980},acceptDownloads:true,
  });
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${url}/?demo=1`);
  await page.waitForFunction(()=>document.getElementById('openValue').textContent==='38');
  assert.equal(await page.locator('#pendingValue').textContent(),'23');
  assert.equal(await page.locator('#demoBanner').isVisible(),true);
  assert.match(await page.locator('#detailSummary').textContent(),/1 个 Bug/);
  assert.match(await page.locator('#detailBody').textContent(),/2245/);
  await page.selectOption('#rangeSelect','7');
  assert.equal(await page.locator('#dailyBody tr').count(),7);
  await page.locator('#detailSearch').fill('not-a-real-bug');
  assert.match(await page.locator('#detailBody').textContent(),/没有匹配项/);
  await page.locator('#detailSearch').fill('2245');
  assert.equal(await page.locator('#detailBody tr').count(),1);
  const downloadPromise=page.waitForEvent('download');await page.locator('#exportDetails').click();
  const download=await downloadPromise;assert.ok(download.suggestedFilename().includes('DEMO'));
  await page.locator('#zoomIncoming').click();assert.equal(await page.locator('#chartDialog').isVisible(),true);
  await page.keyboard.press('Escape');
  await page.locator('#aboutBtn').click();assert.match(await page.locator('#sourceInfo').textContent(),/完整读取/);await page.keyboard.press('Escape');
  await page.screenshot({path:'artifacts/preview-wide.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.documentElement.scrollWidth<=window.innerWidth);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:'artifacts/preview-narrow.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'窄侧栏不应产生整页横向溢出');
  // 无效自定义日期不得保留旧图表数据用于导出。
  await page.selectOption('#rangeSelect','custom');await page.locator('#startDate').fill('2026-10-29');await page.locator('#endDate').fill('2026-10-27');await page.locator('#applyRange').click();
  assert.equal(await page.locator('#rangeError').isVisible(),true);assert.equal(await page.locator('#exportDaily').isDisabled(),true);
  assert.equal(await page.locator('#dailyBody tr').count(),0);
  // 无宿主的真实模式不能偷偷落到模拟数据。
  const disconnected=await context.newPage();await disconnected.goto(url);
  await disconnected.locator('#fatalError').waitFor({state:'visible',timeout:35000});
  assert.equal(await disconnected.locator('#demoBanner').isVisible(),false);
  assert.equal(await disconnected.locator('#openValue').textContent(),'—');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['desktop','narrow390','dedup2245','search','CSV-demo','dialogs','invalid-range-clears','no-host-fails-closed'],screenshots:['artifacts/preview-wide.png','artifacts/preview-narrow.png'],pageErrors:errors},null,2));
}finally{
  await context?.close();await new Promise(resolve=>server.close(resolve));
}
