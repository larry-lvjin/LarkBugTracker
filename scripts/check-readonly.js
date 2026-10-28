import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const files = (await readdir('src')).filter(name => /\.(js|css)$/.test(name));
const blocked = [
  /\.(?:addTable|addField|addRecord|addRecords|setRecord|setRecords|setCellValue|setCellString|deleteRecord|deleteRecords|deleteField|deleteTable|batchCreate|batchUpdate)\s*\(/,
  /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/,
  /tenant_access_token|app_secret|FEISHU_APP_SECRET|\/open-apis\//i,
  /\.innerHTML\s*=|insertAdjacentHTML\s*\(/,
];
for (const name of files) {
  const content = await readFile(join('src', name), 'utf8');
  for (const pattern of blocked) assert.ok(!pattern.test(content), `${name} 命中禁止的写入/网络/密钥/HTML注入路径：${pattern}`);
}
const main = await readFile('src/main.js', 'utf8');
assert.ok(!main.includes('indexedDB'), '不能持久缓存原始 Bug 数据');
const config = await readFile('src/config.js', 'utf8');
assert.ok(config.includes('tbldjYSgIe55Qbcm') && config.includes('tblrtjRhMURlSlOT'));
const source = await readFile('src/feishu.js','utf8');
assert.ok(!source.includes('getActiveTable'), '禁止跟随当前活跃表误读其它表');
assert.ok(source.includes('selection.baseId !== CONFIG.expectedBaseId'), '必须校验 base 身份');
console.log(`只读静态检查通过：${files.length} 个源文件；无飞书数据写入、显式外发、密钥或外部内容 HTML 注入。`);
console.log('注意：此检查不替代源代码审查和真实飞书容器中的只读验收。SDK依赖本身包含通用能力，但应用不调用写入接口。');
