const FEISHU_API = "https://open.feishu.cn/open-apis";
const APP_ID = process.env.FEISHU_APP_ID || "cli_aa8445104379dcb3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "G4VNR37qVKcU80Zpa5axChb0EgaqCk1d";
const APP_TOKEN = "E8mgb7Zoxa0ZhLsND7wcOuxKnee";
const BUG_TABLE_ID = "tbldjYSgIe55Qbcm";
const BUG_VIEW_ID = "vewUHHFITx";
const HISTORY_TABLE_NAME = "BugStats_History";
const MATRIX_TABLE_NAME = "BugStats_DailyMatrix";

// Before this date the matrix-based transitions are not reliable:
// 2026-06-10 is the bootstrap day (no yesterday baseline);
// 2026-06-11's yesterday baseline is the bootstrap snapshot (mid-day 06-10), not an EOD snapshot,
// so 06-11 transitions would conflate ~1.5 days of activity.
// First date where transitions = diff(EOD today, EOD yesterday) is truthful: 2026-06-12.
const FIRST_TRUTHFUL_DATE = "2026-06-12";

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
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`;
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

const CLOSED_STATUSES = ["已关闭", "设计如此", "暂不修复", "无效问题", "已修复，待发版"];

function analyzeRecords(records) {
  const sets = {
    "未解决": new Set(), "待验收": new Set(), "重新打开": new Set(), "已关闭": new Set(),
    "已回归，持续测试": new Set(), "未复现，持续测试": new Set(),
  };
  let testing = 0, testingOld = 0, reviewing = 0, wontfix = 0, dupLink = 0;
  let byDesign = 0, closed = 0, invalid = 0, tempVerify = 0, needLog = 0, fixedPending = 0;
  for (const record of records) {
    const status = extractText(record.fields["问题状态"]);
    const id = record.record_id;
    if (sets[status]) sets[status].add(id);
    if (CLOSED_STATUSES.includes(status)) sets["已关闭"].add(id);
    if (status === "已回归，持续测试") testing++;
    if (status === "未复现，持续测试") testingOld++;
    if (status === "待评审") reviewing++;
    if (status === "暂不修复") wontfix++;
    if (status === "双连接，5月份开始处理") dupLink++;
    if (status === "设计如此") byDesign++;
    if (status === "已关闭") closed++;
    if (status === "无效问题") invalid++;
    if (status === "临时版本验证") tempVerify++;
    if (status === "需补充日志") needLog++;
    if (status === "已修复，待发版") fixedPending++;
  }
  return { total: records.length, sets, testing, testingOld, reviewing, wontfix, dupLink, byDesign, closed, invalid, tempVerify, needLog, fixedPending };
}

function getBeijingYesterday(todayStr) {
  const [y, m, d] = todayStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) - 24 * 3600 * 1000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Feishu single-select color palette (matching source bug table's 问题状态 colors).
const COLOR_RED = 22;      // 未解决_新
const COLOR_YELLOW = 23;   // 重新打开_新
const COLOR_PURPLE = 31;   // 待验收/持续测试_新
const COLOR_GREEN = 26;    // 已关闭组_新
const COLOR_DEFAULT = 0;   // plain options

const ALL_STATUSES = [
  "未解决", "待验收", "重新打开", "已关闭",
  "已回归，持续测试", "未复现，持续测试",
  "设计如此", "暂不修复", "无效问题", "已修复，待发版",
  "待评审", "临时版本验证", "需补充日志", "双连接，5月份开始处理",
  "录音组跟进",
];

function newColorOf(status) {
  if (status === "未解决") return COLOR_RED;
  if (status === "重新打开") return COLOR_YELLOW;
  if (status === "待验收" || status === "已回归，持续测试" || status === "未复现，持续测试") return COLOR_PURPLE;
  if (CLOSED_STATUSES.includes(status)) return COLOR_GREEN;
  return null;
}

function buildDateFieldOptions() {
  const options = [];
  for (const s of ALL_STATUSES) {
    options.push({ name: s, color: COLOR_DEFAULT });
    const c = newColorOf(s);
    if (c !== null) options.push({ name: s + "_新", color: c });
  }
  return options;
}

async function ensureDateField(token, matrixTableId, dateStr) {
  const data = await request(
    `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/fields?page_size=500`,
    { method: "GET", headers: authHeaders(token) }
  );
  const existing = data.data.items.find((f) => f.field_name === dateStr);
  if (existing) {
    return { created: false, isSingleSelect: existing.type === 3 };
  }
  await request(
    `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/fields`,
    {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ field_name: dateStr, type: 3, property: { options: buildDateFieldOptions() } }),
    }
  );
  console.log(`Created matrix field "${dateStr}" (single-select with color options)`);
  return { created: true, isSingleSelect: true };
}

async function fetchMatrixRows(token, matrixTableId) {
  const rows = [];
  let pageToken = undefined;
  for (let page = 0; page < 500; page++) {
    let url = `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/records?page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const data = await request(url, { method: "GET", headers: authHeaders(token) });
    rows.push(...(data.data.items || []));
    console.log(`  Matrix page ${page + 1}: +${data.data.items?.length || 0}, total=${rows.length}`);
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  const byBugId = new Map();
  let dupCount = 0;
  for (const r of rows) {
    const bugId = extractText(r.fields["记录ID"]);
    if (!bugId) continue;
    if (byBugId.has(bugId)) dupCount++;
    byBugId.set(bugId, { matrixRecordId: r.record_id, fields: r.fields });
  }
  if (dupCount > 0) console.log(`⚠️  Matrix has ${dupCount} duplicate rows (same 记录ID)`);
  return { rows, byBugId };
}

async function batchCreate(token, matrixTableId, payloads) {
  for (let i = 0; i < payloads.length; i += 100) {
    const batch = payloads.slice(i, i + 100);
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/records/batch_create`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify({ records: batch }) }
    );
    console.log(`  Matrix create: ${Math.min(i + 100, payloads.length)}/${payloads.length}`);
  }
}

async function batchUpdate(token, matrixTableId, payloads) {
  for (let i = 0; i < payloads.length; i += 100) {
    const batch = payloads.slice(i, i + 100);
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/records/batch_update`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify({ records: batch }) }
    );
    console.log(`  Matrix update: ${Math.min(i + 100, payloads.length)}/${payloads.length}`);
  }
}

async function ensureMatrixTable(token) {
  const data = await request(`${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: "GET", headers: authHeaders(token),
  });
  const found = data.data.items.find((t) => t.name === MATRIX_TABLE_NAME);
  if (found) return found.table_id;
  const created = await request(`${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: "POST", headers: authHeaders(token),
    body: JSON.stringify({
      table: {
        name: MATRIX_TABLE_NAME,
        fields: [
          { field_name: "记录ID", type: 1 },
          { field_name: "问题描述", type: 1 },
          { field_name: "序号", type: 2 },
        ],
      },
    }),
  });
  console.log(`Created table "${MATRIX_TABLE_NAME}" (id=${created.data.table_id})`);
  return created.data.table_id;
}

async function ensureSequenceField(token, matrixTableId) {
  const data = await request(
    `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/fields?page_size=500`,
    { method: "GET", headers: authHeaders(token) }
  );
  const existing = data.data.items.find((f) => f.field_name === "序号");
  if (existing) return existing.field_id;
  const created = await request(
    `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/fields`,
    { method: "POST", headers: authHeaders(token), body: JSON.stringify({ field_name: "序号", type: 2 }) }
  );
  console.log(`Created matrix field "序号"`);
  return created.data.field.field_id;
}

async function ensureMatrixViewSort(token, matrixTableId, seqFieldId) {
  const views = await request(
    `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/views`,
    { method: "GET", headers: authHeaders(token) }
  );
  for (const v of views.data.items || []) {
    if (v.view_type !== "grid") continue;
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/views/${v.view_id}`,
      {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({
          property: { sort_info: { sort_infos: [{ field_id: seqFieldId, desc: false }] } },
        }),
      }
    ).catch((e) => console.log(`  View ${v.view_id} sort PATCH failed: ${e.message}`));
  }
}

async function migrateOldTextDateFields(token, matrixTableId) {
  const fieldsResp = await request(
    `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/fields?page_size=500`,
    { method: "GET", headers: authHeaders(token) }
  );
  const dateFields = fieldsResp.data.items.filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.field_name));
  const textDateFields = dateFields.filter((f) => f.type === 1);
  if (textDateFields.length === 0) return;

  textDateFields.sort((a, b) => a.field_name.localeCompare(b.field_name));
  console.log(`Migrating ${textDateFields.length} text date columns to single-select: ${textDateFields.map((f) => f.field_name).join(", ")}`);

  const allRows = [];
  let pageToken = undefined;
  for (let page = 0; page < 500; page++) {
    let url = `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/records?page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const data = await request(url, { method: "GET", headers: authHeaders(token) });
    allRows.push(...(data.data.items || []));
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }

  const valuesByDate = new Map();
  for (const f of dateFields) {
    const m = new Map();
    for (const r of allRows) {
      const v = extractText(r.fields[f.field_name]);
      if (v) m.set(r.record_id, v);
    }
    valuesByDate.set(f.field_name, m);
  }

  for (const f of textDateFields) {
    const dateStr = f.field_name;
    const yesterdayStr = getBeijingYesterday(dateStr);
    const todayValues = valuesByDate.get(dateStr) || new Map();
    const yestValues = valuesByDate.get(yesterdayStr) || new Map();

    console.log(`  ${dateStr}: ${todayValues.size} non-empty values, deleting + recreating as single-select...`);

    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/fields/${f.field_id}`,
      { method: "DELETE", headers: authHeaders(token) }
    );
    await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${matrixTableId}/fields`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ field_name: dateStr, type: 3, property: { options: buildDateFieldOptions() } }),
      }
    );

    const updates = [];
    for (const [recordId, status] of todayValues) {
      const yestRaw = yestValues.get(recordId) || "";
      const yestNorm = yestRaw.replace(/_新$/, "");
      let dateValue = status;
      if (status !== yestNorm && newColorOf(status) !== null) {
        dateValue = status + "_新";
      }
      updates.push({ record_id: recordId, fields: { [dateStr]: dateValue } });
    }
    if (updates.length > 0) await batchUpdate(token, matrixTableId, updates);
    console.log(`    Wrote ${updates.length} values back to new single-select column`);

    valuesByDate.set(dateStr, new Map(updates.map((u) => [u.record_id, u.fields[dateStr]])));
  }
  console.log(`Migration complete.`);
}

async function writeDailyMatrix(token, matrixTableId, dateStr, yesterdayStr, bugRecords, byBugId, useColorOptions) {
  const toCreate = [];
  const toUpdate = [];
  for (let i = 0; i < bugRecords.length; i++) {
    const r = bugRecords[i];
    const bugId = r.record_id;
    const status = extractText(r.fields["问题状态"]);
    const desc = extractText(r.fields["问题描述"]);
    const seq = i + 1;
    const existing = byBugId.get(bugId);

    let dateValue = status;
    if (useColorOptions && status) {
      const yestRaw = existing ? extractText(existing.fields[yesterdayStr]) : "";
      const yestNorm = yestRaw.replace(/_新$/, "");
      if (status !== yestNorm && newColorOf(status) !== null) {
        dateValue = status + "_新";
      }
    }

    if (existing) {
      toUpdate.push({ record_id: existing.matrixRecordId, fields: { [dateStr]: dateValue, "序号": seq } });
    } else {
      toCreate.push({ fields: { "记录ID": bugId, "问题描述": desc, "序号": seq, [dateStr]: dateValue } });
    }
  }
  console.log(`Writing daily matrix: ${toCreate.length} new rows, ${toUpdate.length} updates`);
  if (toCreate.length > 0) await batchCreate(token, matrixTableId, toCreate);
  if (toUpdate.length > 0) await batchUpdate(token, matrixTableId, toUpdate);
  return { created: toCreate.length, updated: toUpdate.length };
}

function computeTransitionsFromMatrix(bugRecords, byBugId, todayStr, yesterdayStr) {
  const t = { toUnresolved: 0, toPending: 0, toReopened: 0, toClosed: 0, toTesting: 0, toTestingOld: 0 };
  let yestPresent = 0;
  for (const r of bugRecords) {
    const today = extractText(r.fields["问题状态"]);
    const prev = byBugId.get(r.record_id);
    const yest = prev ? extractText(prev.fields[yesterdayStr]) : "";
    if (yest) yestPresent++;
    if (!today || today === yest) continue;
    if (today === "未解决") t.toUnresolved++;
    else if (today === "待验收") t.toPending++;
    else if (today === "重新打开") t.toReopened++;
    else if (today === "已回归，持续测试") t.toTesting++;
    else if (today === "未复现，持续测试") t.toTestingOld++;
    if (CLOSED_STATUSES.includes(today) && !CLOSED_STATUSES.includes(yest)) t.toClosed++;
  }
  if (yestPresent === 0) {
    console.log(`⚠️  No yesterday (${yesterdayStr}) data in matrix — bootstrap day, transitions = 0`);
    return { toUnresolved: 0, toPending: 0, toReopened: 0, toClosed: 0, toTesting: 0, toTestingOld: 0 };
  }
  console.log(`Matrix yesterday-column populated for ${yestPresent}/${bugRecords.length} bugs`);
  return t;
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
  for (const name of ["待验收", "持续测试", "待评审", "暂不修复", "双连接", "设计如此", "已关闭", "无效问题", "未复现持续测试", "临时版本验证", "需补充日志", "已修复，待发版", "其他到未解决", "其他到待验收", "其他到重新打开", "其他到已关闭", "其他到持续测试", "其他到未复现持续测试"]) {
    if (!existing.includes(name)) {
      await request(
        `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields`,
        { method: "POST", headers: authHeaders(token), body: JSON.stringify({ field_name: name, type: 2 }) }
      );
      console.log(`Added field: ${name}`);
    }
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
    "设计如此": data.byDesign,
    "已关闭": data.closed,
    "无效问题": data.invalid,
    "未复现持续测试": data.testingOld,
    "临时版本验证": data.tempVerify,
    "需补充日志": data.needLog,
    "已修复，待发版": data.missing,
    "新增未解决": data.toUnresolved,
    "每日解决": data.toClosed,
    "其他到未解决": data.toUnresolved,
    "其他到待验收": data.toPending,
    "其他到重新打开": data.toReopened,
    "其他到已关闭": data.toClosed,
    "其他到持续测试": data.toTesting,
    "其他到未复现持续测试": data.toTestingOld,
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
  const yesterdayStr = getBeijingYesterday(dateStr);

  console.log(`[${new Date().toISOString()}] Collecting data for ${dateStr} (yesterday=${yesterdayStr})...`);

  const token = await getToken();
  const records = await fetchAllRecords(token);
  const { total, sets, testing, testingOld, reviewing, wontfix, dupLink, byDesign, closed, invalid, tempVerify, needLog, fixedPending } = analyzeRecords(records);

  const unresolved = sets["未解决"].size;
  const pending = sets["待验收"].size;
  const reopened = sets["重新打开"].size;
  const ratio = total > 0 ? parseFloat((((unresolved + reopened) / total) * 100).toFixed(1)) : 0;
  const missing = fixedPending;

  console.log(`Total: ${total}, 未解决: ${unresolved}, 待验收: ${pending}, 重新打开: ${reopened}, 持续测试: ${testing}, 已修复待发版: ${missing}, ratio: ${ratio}%`);

  const matrixTableId = await ensureMatrixTable(token);
  await migrateOldTextDateFields(token, matrixTableId);
  const dateFieldInfo = await ensureDateField(token, matrixTableId, dateStr);
  const seqFieldId = await ensureSequenceField(token, matrixTableId);
  await ensureMatrixViewSort(token, matrixTableId, seqFieldId);

  console.log("Fetching matrix rows...");
  const { byBugId } = await fetchMatrixRows(token, matrixTableId);

  let transitions;
  if (dateStr < FIRST_TRUTHFUL_DATE) {
    console.log(`⚠️  ${dateStr} < FIRST_TRUTHFUL_DATE (${FIRST_TRUTHFUL_DATE}); writing transitions = 0 (matrix baseline not EOD)`);
    transitions = { toUnresolved: 0, toPending: 0, toReopened: 0, toClosed: 0, toTesting: 0, toTestingOld: 0 };
  } else {
    transitions = computeTransitionsFromMatrix(records, byBugId, dateStr, yesterdayStr);
    console.log(`Transitions: toUnresolved=${transitions.toUnresolved} toPending=${transitions.toPending} toReopened=${transitions.toReopened} toClosed=${transitions.toClosed} toTesting=${transitions.toTesting} toTestingOld=${transitions.toTestingOld}`);
  }

  await writeDailyMatrix(token, matrixTableId, dateStr, yesterdayStr, records, byBugId, dateFieldInfo.isSingleSelect);

  const historyTableId = await getTableId(token, HISTORY_TABLE_NAME);
  await ensureFields(token, historyTableId);

  await saveHistoryRecord(token, historyTableId, dateStr, {
    total, unresolved, pending, reopened, ratio, testing, testingOld, reviewing, wontfix, dupLink, byDesign, closed, invalid, tempVerify, needLog, missing, ...transitions,
  });

  console.log("Done!");
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
