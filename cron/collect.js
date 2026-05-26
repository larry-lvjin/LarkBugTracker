const FEISHU_API = "https://open.feishu.cn/open-apis";
const APP_ID = process.env.FEISHU_APP_ID || "cli_aa8445104379dcb3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "G4VNR37qVKcU80Zpa5axChb0EgaqCk1d";
const APP_TOKEN = "E8mgb7Zoxa0ZhLsND7wcOuxKnee";
const BUG_TABLE_ID = "tbldjYSgIe55Qbcm";
const BUG_VIEW_ID = "vewUHHFITx";
const HISTORY_TABLE_NAME = "BugStats_History";
const SNAPSHOT_TABLE_NAME = "BugStats_Snapshot";

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

function extractText(val) {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    const first = val[0];
    if (!first) return "";
    if (typeof first === "string") return first;
    return first.text || first.name || String(first);
  }
  if (typeof val === "object") return val.text || val.name || "";
  return String(val);
}

function pad(n) { return String(n).padStart(2, "0"); }
function formatDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function getBeijingDate() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  return formatDate(beijing);
}

async function fetchAllRecords(token) {
  const records = [];
  let pageToken = undefined;
  for (let page = 0; page < 50; page++) {
    let url = `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${BUG_TABLE_ID}/records?view_id=${BUG_VIEW_ID}&page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const data = await request(url, { method: "GET", headers: authHeaders(token) });
    records.push(...(data.data.items || []));
    console.log(`  Page ${page + 1}: fetched ${data.data.items?.length || 0}, total: ${records.length}`);
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  return records;
}

function analyzeRecords(records) {
  const sets = {
    "未解决": new Set(), "待验收": new Set(), "重新打开": new Set(), "已关闭": new Set(),
    "未复现，持续测试": new Set(),
  };
  let testing = 0, reviewing = 0, wontfix = 0, dupLink = 0;
  for (const record of records) {
    const status = extractText(record.fields["问题状态"]);
    const id = record.record_id;
    if (sets[status]) sets[status].add(id);
    if (status === "未复现，持续测试") testing++;
    if (status === "待评审") reviewing++;
    if (status === "暂不修复") wontfix++;
    if (status === "双连接，5月开始处理") dupLink++;
  }
  return { total: records.length, sets, testing, reviewing, wontfix, dupLink };
}

function computeTransitions(todaySets, yesterdaySets) {
  const diff = (today, yesterday) => {
    let count = 0;
    for (const id of today) { if (!yesterday.has(id)) count++; }
    return count;
  };
  return {
    toUnresolved: diff(todaySets["未解决"], yesterdaySets["未解决"]),
    toPending: diff(todaySets["待验收"], yesterdaySets["待验收"]),
    toReopened: diff(todaySets["重新打开"], yesterdaySets["重新打开"]),
    toClosed: diff(todaySets["已关闭"], yesterdaySets["已关闭"]),
    toTesting: diff(todaySets["未复现，持续测试"], yesterdaySets["未复现，持续测试"]),
  };
}

async function getTableId(token, tableName) {
  const data = await request(`${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: "GET", headers: authHeaders(token),
  });
  const table = data.data.items.find((t) => t.name === tableName);
  if (!table) throw new Error(`Table "${tableName}" not found`);
  return table.table_id;
}

async function ensureFields(token, tableId) {
  const data = await request(
    `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`,
    { method: "GET", headers: authHeaders(token) }
  );
  const existing = data.data.items.map((f) => f.field_name);
  for (const name of ["待验收", "持续测试", "待评审", "暂不修复", "双连接", "其他到未解决", "其他到待验收", "其他到重新打开", "其他到已关闭", "其他到持续测试"]) {
    if (!existing.includes(name)) {
      await request(
        `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`,
        { method: "POST", headers: authHeaders(token), body: JSON.stringify({ field_name: name, type: 2 }) }
      );
      console.log(`Added field: ${name}`);
    }
  }
}

async function loadSnapshot(token, snapshotTableId, dateStr) {
  const emptySets = { "未解决": new Set(), "待验收": new Set(), "重新打开": new Set(), "已关闭": new Set(), "未复现，持续测试": new Set() };
  let pageToken = undefined;
  for (let page = 0; page < 10; page++) {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const data = await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${snapshotTableId}/records/search`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
    ).catch(() => ({ data: { items: [], has_more: false } }));
    for (const r of data.data.items || []) {
      const d = extractText(r.fields["日期"]);
      if (d && d.slice(0, 10) === dateStr) {
        const parse = (field) => {
          const val = extractText(r.fields[field]);
          return val ? new Set(val.split(",").filter(Boolean)) : new Set();
        };
        return {
          "未解决": parse("未解决_ids"),
          "待验收": parse("待验收_ids"),
          "重新打开": parse("重新打开_ids"),
          "已关闭": parse("已关闭_ids"),
          "未复现，持续测试": parse("持续测试_ids"),
        };
      }
    }
    if (!data.data.has_more) break;
    pageToken = data.data.page_token;
  }
  console.log(`No snapshot found for ${dateStr}, using empty sets`);
  return emptySets;
}

async function saveSnapshot(token, snapshotTableId, dateStr, sets) {
  let existingId = null;
  let pageToken = undefined;
  for (let page = 0; page < 10; page++) {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const data = await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${snapshotTableId}/records/search`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
    ).catch(() => ({ data: { items: [], has_more: false } }));
    for (const r of data.data.items || []) {
      const d = extractText(r.fields["日期"]);
      if (d && d.slice(0, 10) === dateStr) { existingId = r.record_id; break; }
    }
    if (existingId || !data.data.has_more) break;
    pageToken = data.data.page_token;
  }

  const fields = {
    "日期": dateStr,
    "未解决_ids": Array.from(sets["未解决"]).join(","),
    "待验收_ids": Array.from(sets["待验收"]).join(","),
    "重新打开_ids": Array.from(sets["重新打开"]).join(","),
    "已关闭_ids": Array.from(sets["已关闭"]).join(","),
    "持续测试_ids": Array.from(sets["未复现，持续测试"]).join(","),
  };

  if (existingId) {
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${snapshotTableId}/records/${existingId}`,
      { method: "PUT", headers: authHeaders(token), body: JSON.stringify({ fields }) }
    );
  } else {
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${snapshotTableId}/records`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify({ fields }) }
    );
  }
}

async function cleanOldSnapshots(token, snapshotTableId, keepDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffStr = formatDate(cutoff);

  const toDelete = [];
  let pageToken = undefined;
  for (let page = 0; page < 10; page++) {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const data = await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${snapshotTableId}/records/search`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
    ).catch(() => ({ data: { items: [], has_more: false } }));
    for (const r of data.data.items || []) {
      const d = extractText(r.fields["日期"]);
      if (d && d.slice(0, 10) < cutoffStr) toDelete.push(r.record_id);
    }
    if (!data.data.has_more) break;
    pageToken = data.data.page_token;
  }

  if (toDelete.length > 0) {
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${snapshotTableId}/records/batch_delete`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify({ records: toDelete }) }
    );
    console.log(`Cleaned ${toDelete.length} old snapshots`);
  }
}

async function saveHistoryRecord(token, historyTableId, dateStr, data) {
  let existingId = null;
  let pageToken = undefined;
  while (true) {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const resp = await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${historyTableId}/records/search`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
    ).catch(() => ({ data: { items: [], has_more: false } }));
    for (const r of resp.data.items || []) {
      const d = extractText(r.fields["日期"]);
      if (d && d.slice(0, 10) === dateStr) { existingId = r.record_id; break; }
    }
    if (existingId || !resp.data.has_more) break;
    pageToken = resp.data.page_token;
  }

  const fields = {
    "日期": dateStr,
    "总数": data.total,
    "未解决": data.unresolved,
    "待验收": data.pending,
    "重新打开": data.reopened,
    "占比(%)": data.ratio,
    "持续测试": data.testing,
    "待评审": data.reviewing,
    "暂不修复": data.wontfix,
    "双连接": data.dupLink,
    "新增未解决": data.toUnresolved,
    "每日解决": data.toClosed,
    "其他到未解决": data.toUnresolved,
    "其他到待验收": data.toPending,
    "其他到重新打开": data.toReopened,
    "其他到已关闭": data.toClosed,
    "其他到持续测试": data.toTesting,
  };

  if (existingId) {
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${historyTableId}/records/${existingId}`,
      { method: "PUT", headers: authHeaders(token), body: JSON.stringify({ fields }) }
    );
    console.log(`Updated record for ${dateStr}`);
  } else {
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${historyTableId}/records`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify({ fields }) }
    );
    console.log(`Created record for ${dateStr}`);
  }
}

async function main() {
  const dateStr = getBeijingDate();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = formatDate(new Date(yesterday.getTime() + 8 * 3600 * 1000));

  console.log(`[${new Date().toISOString()}] Collecting data for ${dateStr}...`);

  const token = await getToken();
  const records = await fetchAllRecords(token);
  const { total, sets, testing, reviewing, wontfix, dupLink } = analyzeRecords(records);

  const unresolved = sets["未解决"].size;
  const pending = sets["待验收"].size;
  const reopened = sets["重新打开"].size;
  const ratio = total > 0 ? parseFloat((((unresolved + reopened) / total) * 100).toFixed(1)) : 0;

  console.log(`Total: ${total}, 未解决: ${unresolved}, 待验收: ${pending}, 重新打开: ${reopened}, 持续测试: ${testing}, ratio: ${ratio}%`);

  const historyTableId = await getTableId(token, HISTORY_TABLE_NAME);
  await ensureFields(token, historyTableId);

  const snapshotTableId = await getTableId(token, SNAPSHOT_TABLE_NAME);

  console.log(`Loading yesterday's snapshot (${yesterdayStr})...`);
  const yesterdaySets = await loadSnapshot(token, snapshotTableId, yesterdayStr);
  const transitions = computeTransitions(sets, yesterdaySets);

  console.log(`Transitions: toUnresolved=${transitions.toUnresolved} toPending=${transitions.toPending} toReopened=${transitions.toReopened} toClosed=${transitions.toClosed}`);

  await saveHistoryRecord(token, historyTableId, dateStr, {
    total, unresolved, pending, reopened, ratio, testing, reviewing, wontfix, dupLink, ...transitions,
  });

  console.log("Saving today's snapshot...");
  await saveSnapshot(token, snapshotTableId, dateStr, sets);

  await cleanOldSnapshots(token, snapshotTableId, 7);
  console.log("Done!");
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
