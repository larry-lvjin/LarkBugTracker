// Fix the corrupt 2026-05-28 history row.
// Strategy: use backfill's approximateStatus logic on a per-day basis to
// reconstruct 05-28 values from current bug records, then UPDATE only that row.

const FEISHU_API = "https://open.feishu.cn/open-apis";
const APP_ID = process.env.FEISHU_APP_ID || "cli_aa8445104379dcb3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "G4VNR37qVKcU80Zpa5axChb0EgaqCk1d";
const APP_TOKEN = "E8mgb7Zoxa0ZhLsND7wcOuxKnee";
const BUG_TABLE_ID = "tbldjYSgIe55Qbcm";
const BUG_VIEW_ID = "vewUHHFITx";
const HISTORY_TABLE_NAME = "BugStats_History";
const SNAPSHOT_TABLE_NAME = "BugStats_Snapshot";
const TARGET_DATE = "2026-05-28";
const PREV_DATE = "2026-05-27";

const TRACKED_STATUSES = [
  "未解决", "待验收", "重新打开", "已关闭",
  "已回归，持续测试", "未复现，持续测试", "设计如此", "暂不修复",
  "无效问题", "待评审", "临时版本验证", "需补充日志", "双连接，5月份开始处理",
];
const CLOSED_STATUSES = ["已关闭", "设计如此", "暂不修复", "无效问题"];

async function request(url, options = {}) {
  const resp = await fetch(url, options);
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`API ${data.code}: ${data.msg}`);
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
  if (!lastT || lastT <= effectiveResolve) return finalStatus;
  if (dayStr < lastT) return "待验收";
  return finalStatus;
}

async function fetchAllRecords(token) {
  const records = [];
  let pageToken = undefined;
  for (let p = 0; p < 50; p++) {
    let url = `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${BUG_TABLE_ID}/records?view_id=${BUG_VIEW_ID}&page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const data = await request(url, { method: "GET", headers: authHeaders(token) });
    records.push(...(data.data.items || []));
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  return records;
}

async function getTableId(token, name) {
  const data = await request(`${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: "GET", headers: authHeaders(token),
  });
  return data.data.items.find((t) => t.name === name)?.table_id;
}

async function findHistoryRecord(token, tableId, dateStr) {
  let pageToken = undefined;
  for (let p = 0; p < 10; p++) {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const data = await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/search`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
    );
    for (const r of data.data.items || []) {
      const d = extractText(r.fields["日期"]);
      if (d && d.slice(0, 10) === dateStr) return r.record_id;
    }
    if (!data.data.has_more) break;
    pageToken = data.data.page_token;
  }
  return null;
}

async function loadSnapshot(token, snapshotTableId, dateStr) {
  let pageToken = undefined;
  for (let p = 0; p < 10; p++) {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const data = await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${snapshotTableId}/records/search`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
    );
    for (const r of data.data.items || []) {
      const d = extractText(r.fields["日期"]);
      if (d && d.slice(0, 10) === dateStr) {
        const parse = (f) => {
          const v = extractText(r.fields[f]);
          return v ? new Set(v.split(",").filter(Boolean)) : new Set();
        };
        return {
          "未解决": parse("未解决_ids"),
          "待验收": parse("待验收_ids"),
          "重新打开": parse("重新打开_ids"),
          "已关闭": parse("已关闭_ids"),
          "已回归，持续测试": parse("持续测试_ids"),
          "未复现，持续测试": parse("未复现持续测试_ids"),
        };
      }
    }
    if (!data.data.has_more) break;
    pageToken = data.data.page_token;
  }
  return null;
}

async function main() {
  const token = await getToken();

  console.log(`Checking snapshot for ${TARGET_DATE}...`);
  const snapshotTableId = await getTableId(token, SNAPSHOT_TABLE_NAME);
  const snap = await loadSnapshot(token, snapshotTableId, TARGET_DATE);
  if (snap) {
    console.log(`Snapshot found: 未解决=${snap["未解决"].size} 待验收=${snap["待验收"].size} 重新打开=${snap["重新打开"].size} 已关闭=${snap["已关闭"].size}`);
  } else {
    console.log(`No snapshot for ${TARGET_DATE}`);
  }

  console.log(`Reconstructing ${TARGET_DATE} from current bug records via approximateStatus...`);
  const records = await fetchAllRecords(token);
  const bugs = records.map((r) => ({
    id: r.record_id,
    createdDate: tsToDateStr(r.fields["创建时间"]),
    status: extractText(r.fields["问题状态"]),
    resolveDate: tsToDateStr(r.fields["解决日期"]),
    lastTransition: tsToDateStr(r.fields["最近流转时间"]),
  })).filter((b) => b.createdDate);
  console.log(`Bugs with createdDate: ${bugs.length} of ${records.length}`);

  const sets = {};
  for (const st of TRACKED_STATUSES) sets[st] = new Set();
  let total = 0;
  for (const bug of bugs) {
    if (bug.createdDate > TARGET_DATE) continue;
    total++;
    const status = approximateStatus(bug, TARGET_DATE);
    if (status && sets[status]) sets[status].add(bug.id);
  }

  const unresolved = sets["未解决"].size;
  const pending = sets["待验收"].size;
  const reopened = sets["重新打开"].size;
  const closed = sets["已关闭"].size;
  const testing = sets["已回归，持续测试"].size;
  const testingOld = sets["未复现，持续测试"].size;
  const byDesign = sets["设计如此"].size;
  const wontfix = sets["暂不修复"].size;
  const invalid = sets["无效问题"].size;
  const reviewing = sets["待评审"].size;
  const tempVerify = sets["临时版本验证"].size;
  const needLog = sets["需补充日志"].size;
  const dupLink = sets["双连接，5月份开始处理"].size;
  const tracked = unresolved + pending + reopened + closed + testing + testingOld + byDesign + wontfix + invalid + reviewing + tempVerify + needLog + dupLink;
  const missing = total - tracked;
  const ratio = total > 0 ? parseFloat((((unresolved + reopened) / total) * 100).toFixed(1)) : 0;

  console.log(`Reconstructed ${TARGET_DATE}: total=${total} 未解决=${unresolved} 待验收=${pending} 重新打开=${reopened} 已关闭=${closed} 已回归持续测试=${testing} 未复现持续测试=${testingOld} 待评审=${reviewing} 暂不修复=${wontfix} 双连接=${dupLink} 设计如此=${byDesign} 无效=${invalid} missing=${missing} ratio=${ratio}%`);

  // Compute transitions from 05-27 to 05-28 using approximateStatus for both days
  const prevSets = {};
  for (const st of TRACKED_STATUSES) prevSets[st] = new Set();
  for (const bug of bugs) {
    if (bug.createdDate > PREV_DATE) continue;
    const status = approximateStatus(bug, PREV_DATE);
    if (status && prevSets[status]) prevSets[status].add(bug.id);
  }
  const diff = (today, yesterday) => {
    let c = 0;
    for (const id of today) if (!yesterday.has(id)) c++;
    return c;
  };
  const closedAll = new Set([...sets["已关闭"], ...sets["设计如此"], ...sets["暂不修复"], ...sets["无效问题"]]);
  const prevClosedAll = new Set([...prevSets["已关闭"], ...prevSets["设计如此"], ...prevSets["暂不修复"], ...prevSets["无效问题"]]);
  const toUnresolved = diff(sets["未解决"], prevSets["未解决"]);
  const toPending = diff(sets["待验收"], prevSets["待验收"]);
  const toReopened = diff(sets["重新打开"], prevSets["重新打开"]);
  const toClosed = diff(closedAll, prevClosedAll);
  const toTesting = diff(sets["已回归，持续测试"], prevSets["已回归，持续测试"]);

  console.log(`Transitions: toUnresolved=${toUnresolved} toPending=${toPending} toReopened=${toReopened} toClosed=${toClosed} toTesting=${toTesting}`);

  const historyTableId = await getTableId(token, HISTORY_TABLE_NAME);
  const recordId = await findHistoryRecord(token, historyTableId, TARGET_DATE);
  if (!recordId) { console.log("Row for 05-28 not found in history"); return; }

  const fields = {
    "日期": TARGET_DATE,
    "总数": total,
    "未解决": unresolved,
    "待验收": pending,
    "重新打开": reopened,
    "占比(%)": ratio,
    "持续测试": testing,
    "待评审": reviewing,
    "暂不修复": wontfix,
    "双连接": dupLink,
    "设计如此": byDesign,
    "已关闭": closed,
    "无效问题": invalid,
    "未复现持续测试": testingOld,
    "临时版本验证": tempVerify,
    "需补充日志": needLog,
    "已修复，待发版": missing,
    "新增未解决": toUnresolved,
    "每日解决": toClosed,
    "其他到未解决": toUnresolved,
    "其他到待验收": toPending,
    "其他到重新打开": toReopened,
    "其他到已关闭": toClosed,
    "其他到持续测试": toTesting,
  };

  await request(
    `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${historyTableId}/records/${recordId}`,
    { method: "PUT", headers: authHeaders(token), body: JSON.stringify({ fields }) }
  );
  console.log(`✓ Updated history row for ${TARGET_DATE}`);
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
