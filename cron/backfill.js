const FEISHU_API = "https://open.feishu.cn/open-apis";
const APP_ID = process.env.FEISHU_APP_ID || "cli_aa8445104379dcb3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "G4VNR37qVKcU80Zpa5axChb0EgaqCk1d";
const APP_TOKEN = "E8mgb7Zoxa0ZhLsND7wcOuxKnee";
const BUG_TABLE_ID = "tbldjYSgIe55Qbcm";
const BUG_VIEW_ID = "vewUHHFITx";
const HISTORY_TABLE_NAME = "BugStats_History";
const SNAPSHOT_TABLE_NAME = "BugStats_Snapshot";

const TRACKED_STATUSES = [
  "未解决", "待验收", "重新打开", "已关闭",
  "已回归，持续测试", "未复现，持续测试", "设计如此", "暂不修复",
  "无效问题", "待评审", "临时版本验证", "需补充日志", "双连接，5月份开始处理",
];
const CLOSED_STATUSES = ["已关闭", "设计如此", "暂不修复", "无效问题"];

async function request(url, options = {}) {
  const resp = await fetch(url, options);
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`API error ${data.code}: ${data.msg}`);
  return data;
}

async function getToken() {
  const data = await request(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  return data.tenant_access_token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" };
}

function pad(n) { return String(n).padStart(2, "0"); }
function formatDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function tsToDateStr(val) {
  if (val == null) return null;
  const ts = typeof val === "number" ? val : Number(val);
  if (isNaN(ts)) return null;
  return formatDate(new Date(ts));
}

function extractText(val) {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    const f = val[0];
    if (!f) return "";
    return typeof f === "string" ? f : f.text || f.name || String(f);
  }
  if (typeof val === "object") return val.text || val.name || "";
  return String(val);
}

async function fetchAllRecords(token) {
  const records = [];
  let pageToken = undefined;
  for (let page = 0; page < 100; page++) {
    let url = `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${BUG_TABLE_ID}/records?view_id=${BUG_VIEW_ID}&page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const data = await request(url, { method: "GET", headers: authHeaders(token) });
    records.push(...(data.data.items || []));
    console.log(`  Page ${page + 1}: ${records.length} records`);
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  return records;
}

function approximateStatus(bug, dayStr) {
  const created = bug.createdDate;
  if (!created || dayStr < created) return null;

  const resolve = bug.resolveDate;
  const lastT = bug.lastTransition;
  const finalStatus = bug.status;

  const effectiveResolve = resolve || (finalStatus !== "未解决" ? (lastT || created) : null);

  if (!effectiveResolve || dayStr < effectiveResolve) {
    if (lastT && dayStr >= lastT && finalStatus === "重新打开") return "重新打开";
    return "未解决";
  }

  if (!lastT || lastT <= effectiveResolve) {
    return finalStatus;
  }

  if (dayStr < lastT) return "待验收";

  return finalStatus;
}

function buildDailySets(records) {
  const bugs = records.map((r) => ({
    id: r.record_id,
    createdDate: tsToDateStr(r.fields["创建时间"]),
    status: extractText(r.fields["问题状态"]),
    resolveDate: tsToDateStr(r.fields["解决日期"]),
    lastTransition: tsToDateStr(r.fields["最近流转时间"]),
  })).filter((b) => b.createdDate);

  const allCreated = bugs.map((b) => b.createdDate).sort();
  if (allCreated.length === 0) return [];

  const firstDate = allCreated[0];
  const today = formatDate(new Date());
  const results = [];

  const current = new Date(firstDate + "T00:00:00");
  const end = new Date(today + "T00:00:00");

  const emptyStatusSets = () => {
    const s = {};
    for (const st of TRACKED_STATUSES) s[st] = new Set();
    return s;
  };
  let prevSets = emptyStatusSets();

  while (current <= end) {
    const dateStr = formatDate(current);

    const todaySets = emptyStatusSets();
    let total = 0;

    for (const bug of bugs) {
      if (bug.createdDate > dateStr) continue;
      total++;
      const status = approximateStatus(bug, dateStr);
      if (status && todaySets[status]) todaySets[status].add(bug.id);
    }

    const unresolved = todaySets["未解决"].size;
    const pending = todaySets["待验收"].size;
    const reopened = todaySets["重新打开"].size;
    const closed = todaySets["已关闭"].size;
    const testing = todaySets["已回归，持续测试"].size;
    const testingOld = todaySets["未复现，持续测试"].size;
    const byDesign = todaySets["设计如此"].size;
    const wontfix = todaySets["暂不修复"].size;
    const invalid = todaySets["无效问题"].size;
    const reviewing = todaySets["待评审"].size;
    const tempVerify = todaySets["临时版本验证"].size;
    const needLog = todaySets["需补充日志"].size;
    const dupLink = todaySets["双连接，5月份开始处理"].size;
    const tracked = unresolved + pending + reopened + closed + testing + testingOld + byDesign + wontfix + invalid + reviewing + tempVerify + needLog + dupLink;
    const missing = total - tracked;
    const ratio = total > 0 ? parseFloat((((unresolved + reopened) / total) * 100).toFixed(1)) : 0;

    const setDiff = (today, yesterday) => {
      let count = 0;
      for (const id of today) { if (!yesterday.has(id)) count++; }
      return count;
    };

    const closedAll = new Set([...todaySets["已关闭"], ...todaySets["设计如此"], ...todaySets["暂不修复"], ...todaySets["无效问题"]]);
    const prevClosedAll = new Set([...prevSets["已关闭"], ...prevSets["设计如此"], ...prevSets["暂不修复"], ...prevSets["无效问题"]]);

    results.push({
      date: dateStr, total, unresolved, pending, reopened, closed, ratio,
      testing, testingOld, byDesign, wontfix, invalid, reviewing, tempVerify, needLog, dupLink, missing,
      toUnresolved: setDiff(todaySets["未解决"], prevSets["未解决"]),
      toPending: setDiff(todaySets["待验收"], prevSets["待验收"]),
      toReopened: setDiff(todaySets["重新打开"], prevSets["重新打开"]),
      toClosed: setDiff(closedAll, prevClosedAll),
      toTesting: setDiff(todaySets["已回归，持续测试"], prevSets["已回归，持续测试"]),
    });

    prevSets = todaySets;
    current.setDate(current.getDate() + 1);
  }

  return { results, lastSets: prevSets };
}

async function getOrCreateTable(token, tableName, fields) {
  const data = await request(`${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: "GET", headers: authHeaders(token),
  });
  const table = data.data.items.find((t) => t.name === tableName);
  if (table) return table.table_id;

  const createData = await request(`${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: "POST", headers: authHeaders(token),
    body: JSON.stringify({ table: { name: tableName, fields } }),
  });
  return createData.data.table_id;
}

async function ensureFields(token, tableId, requiredFields) {
  const data = await request(
    `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`,
    { method: "GET", headers: authHeaders(token) }
  );
  const existing = data.data.items.map((f) => f.field_name);
  for (const { name, type } of requiredFields) {
    if (!existing.includes(name)) {
      await request(
        `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`,
        { method: "POST", headers: authHeaders(token), body: JSON.stringify({ field_name: name, type }) }
      );
      console.log(`Added field: ${name}`);
    }
  }
}

async function clearTable(token, tableId) {
  const ids = [];
  let pageToken = undefined;
  for (let page = 0; page < 50; page++) {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const data = await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/search`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
    ).catch(() => ({ data: { items: [], has_more: false } }));
    for (const r of data.data.items || []) ids.push(r.record_id);
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/batch_delete`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify({ records: batch }) }
    );
    console.log(`  Deleted ${Math.min(i + 200, ids.length)}/${ids.length}`);
  }
}

async function batchInsert(token, tableId, records) {
  for (let i = 0; i < records.length; i += 100) {
    const batch = records.slice(i, i + 100);
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/batch_create`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify({ records: batch }) }
    );
    console.log(`  Inserted ${Math.min(i + 100, records.length)}/${records.length}`);
  }
}

async function main() {
  console.log("=== Backfill Historical Data (Set-Based Rebuild) ===");
  const token = await getToken();

  console.log("Fetching all bug records...");
  const records = await fetchAllRecords(token);
  console.log(`Total records: ${records.length}`);

  console.log("Building daily sets and computing transitions...");
  const { results: dailyStats, lastSets } = buildDailySets(records);
  console.log(`Date range: ${dailyStats[0]?.date} ~ ${dailyStats[dailyStats.length - 1]?.date} (${dailyStats.length} days)`);

  const s = dailyStats[dailyStats.length - 1];
  if (s) {
    console.log(`Latest: total=${s.total} unresolved=${s.unresolved} pending=${s.pending} reopened=${s.reopened} closed=${s.closed} ratio=${s.ratio}%`);
    console.log(`Transitions: toUnresolved=${s.toUnresolved} toPending=${s.toPending} toReopened=${s.toReopened} toClosed=${s.toClosed}`);
  }

  const historyTableId = await getOrCreateTable(token, HISTORY_TABLE_NAME, [
    { field_name: "日期", type: 1 },
    { field_name: "总数", type: 2 },
    { field_name: "未解决", type: 2 },
    { field_name: "占比(%)", type: 2 },
    { field_name: "新增未解决", type: 2 },
    { field_name: "每日解决", type: 2 },
    { field_name: "重新打开", type: 2 },
  ]);

  await ensureFields(token, historyTableId, [
    { name: "待验收", type: 2 },
    { name: "持续测试", type: 2 },
    { name: "待评审", type: 2 },
    { name: "暂不修复", type: 2 },
    { name: "双连接", type: 2 },
    { name: "设计如此", type: 2 },
    { name: "已关闭", type: 2 },
    { name: "无效问题", type: 2 },
    { name: "未复现持续测试", type: 2 },
    { name: "临时版本验证", type: 2 },
    { name: "需补充日志", type: 2 },
    { name: "消失的状态", type: 2 },
    { name: "其他到未解决", type: 2 },
    { name: "其他到待验收", type: 2 },
    { name: "其他到重新打开", type: 2 },
    { name: "其他到已关闭", type: 2 },
    { name: "其他到持续测试", type: 2 },
  ]);

  console.log("Clearing old history records...");
  await clearTable(token, historyTableId);

  const toInsert = dailyStats.map((s) => ({
    fields: {
      "日期": s.date,
      "总数": s.total,
      "未解决": s.unresolved,
      "待验收": s.pending,
      "重新打开": s.reopened,
      "占比(%)": s.ratio,
      "新增未解决": s.toUnresolved,
      "每日解决": s.toClosed,
      "持续测试": s.testing,
      "待评审": s.reviewing,
      "暂不修复": s.wontfix,
      "双连接": s.dupLink,
      "设计如此": s.byDesign,
      "已关闭": s.closed,
      "无效问题": s.invalid,
      "未复现持续测试": s.testingOld,
      "临时版本验证": s.tempVerify,
      "需补充日志": s.needLog,
      "消失的状态": s.missing,
      "其他到未解决": s.toUnresolved,
      "其他到待验收": s.toPending,
      "其他到重新打开": s.toReopened,
      "其他到已关闭": s.toClosed,
      "其他到持续测试": s.toTesting || 0,
    },
  }));

  console.log(`Inserting ${toInsert.length} history records...`);
  await batchInsert(token, historyTableId, toInsert);

  const snapshotTableId = await getOrCreateTable(token, SNAPSHOT_TABLE_NAME, [
    { field_name: "日期", type: 1 },
    { field_name: "未解决_ids", type: 1 },
    { field_name: "待验收_ids", type: 1 },
    { field_name: "重新打开_ids", type: 1 },
    { field_name: "已关闭_ids", type: 1 },
    { field_name: "持续测试_ids", type: 1 },
    { field_name: "未复现持续测试_ids", type: 1 },
  ]);

  await ensureFields(token, snapshotTableId, [
    { name: "持续测试_ids", type: 1 },
    { name: "未复现持续测试_ids", type: 1 },
  ]);

  console.log("Clearing old snapshots...");
  await clearTable(token, snapshotTableId);

  const todayStr = dailyStats[dailyStats.length - 1]?.date;
  if (todayStr && lastSets) {
    console.log("Saving today's snapshot...");
    const closedIds = new Set([...lastSets["已关闭"], ...lastSets["设计如此"], ...lastSets["暂不修复"], ...lastSets["无效问题"]]);
    await batchInsert(token, snapshotTableId, [{
      fields: {
        "日期": todayStr,
        "未解决_ids": Array.from(lastSets["未解决"]).join(","),
        "待验收_ids": Array.from(lastSets["待验收"]).join(","),
        "重新打开_ids": Array.from(lastSets["重新打开"]).join(","),
        "已关闭_ids": Array.from(closedIds).join(","),
        "持续测试_ids": Array.from(lastSets["已回归，持续测试"]).join(","),
        "未复现持续测试_ids": Array.from(lastSets["未复现，持续测试"]).join(","),
      },
    }]);
    console.log(`Snapshot saved: 未解决=${lastSets["未解决"].size} 待验收=${lastSets["待验收"].size} 重新打开=${lastSets["重新打开"].size} 已关闭=${closedIds.size} 持续测试=${lastSets["已回归，持续测试"].size}`);
  }

  console.log("Done!");
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
