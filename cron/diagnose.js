const FEISHU_API = "https://open.feishu.cn/open-apis";
const APP_ID = process.env.FEISHU_APP_ID || "cli_aa8445104379dcb3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "G4VNR37qVKcU80Zpa5axChb0EgaqCk1d";
const APP_TOKEN = "E8mgb7Zoxa0ZhLsND7wcOuxKnee";
const BUG_TABLE_ID = "tbldjYSgIe55Qbcm";
const BUG_VIEW_ID = "vewUHHFITx";
const HISTORY_TABLE_NAME = "BugStats_History";

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
    const f = val[0];
    if (!f) return "";
    return typeof f === "string" ? f : f.text || f.name || String(f);
  }
  if (typeof val === "object") return val.text || val.name || "";
  return String(val);
}

async function main() {
  const token = await getToken();

  console.log("\n=== 1. Live bug view records (using view filter) ===");
  let viewRecords = [];
  let pageToken = undefined;
  for (let p = 0; p < 50; p++) {
    let url = `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${BUG_TABLE_ID}/records?view_id=${BUG_VIEW_ID}&page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const data = await request(url, { method: "GET", headers: authHeaders(token) });
    viewRecords.push(...(data.data.items || []));
    console.log(`  Page ${p + 1}: +${data.data.items?.length || 0}, total=${viewRecords.length}, has_more=${data.data.has_more}`);
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  console.log(`View ${BUG_VIEW_ID} total: ${viewRecords.length}`);

  const statusCounts = {};
  for (const r of viewRecords) {
    const s = extractText(r.fields["问题状态"]) || "(空)";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }
  console.log("Status breakdown:");
  for (const [k, v] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log("\n=== 2. ALL bug records (no view filter) ===");
  let allRecords = [];
  pageToken = undefined;
  for (let p = 0; p < 50; p++) {
    let url = `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${BUG_TABLE_ID}/records?page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;
    const data = await request(url, { method: "GET", headers: authHeaders(token) });
    allRecords.push(...(data.data.items || []));
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  console.log(`No-view total: ${allRecords.length}`);

  console.log("\n=== 3. History table — last 3 rows ===");
  const tablesData = await request(`${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: "GET", headers: authHeaders(token),
  });
  const histTable = tablesData.data.items.find((t) => t.name === HISTORY_TABLE_NAME);
  if (!histTable) { console.log("No history table"); return; }

  let histRecords = [];
  pageToken = undefined;
  for (let p = 0; p < 10; p++) {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const data = await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${histTable.table_id}/records/search`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
    );
    histRecords.push(...(data.data.items || []));
    if (!data.data.has_more) break;
    pageToken = data.data.page_token;
  }

  histRecords.sort((a, b) => extractText(b.fields["日期"]).localeCompare(extractText(a.fields["日期"])));
  for (const r of histRecords.slice(0, 5)) {
    const date = extractText(r.fields["日期"]);
    const total = r.fields["总数"];
    const unresolved = r.fields["未解决"];
    const pending = r.fields["待验收"];
    const closed = r.fields["已关闭"];
    const reopened = r.fields["重新打开"];
    console.log(`  ${date}: total=${total} 未解决=${unresolved} 待验收=${pending} 重新打开=${reopened} 已关闭=${closed}`);
  }
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
