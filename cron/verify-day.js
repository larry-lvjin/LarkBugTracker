// Verify "today became 未解决" count by diffing BugStats_Snapshot's 未解决_ids list.
// Output: actual bug IDs + 问题描述 that newly turned 未解决 between (date-1) and date.

const FEISHU_API = "https://open.feishu.cn/open-apis";
const APP_ID = process.env.FEISHU_APP_ID || "cli_aa8445104379dcb3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "G4VNR37qVKcU80Zpa5axChb0EgaqCk1d";
const APP_TOKEN = "E8mgb7Zoxa0ZhLsND7wcOuxKnee";
const SNAPSHOT_TABLE_ID = "tblssk7SUE5uWiiq";  // BugStats_Snapshot
const BUG_TABLE_ID = "tbldjYSgIe55Qbcm";

const TARGET_DATE = process.argv[2] || "2026-06-16";

function pad(n) { return String(n).padStart(2, "0"); }
function getYesterday(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) - 24 * 3600 * 1000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

async function request(url, options = {}) {
  const resp = await fetch(url, options);
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`API ${data.code}: ${data.msg}`);
  return data;
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
  const yesterday = getYesterday(TARGET_DATE);
  console.log(`Verifying transitions: ${yesterday} → ${TARGET_DATE}\n`);

  const td = await request(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const h = { Authorization: `Bearer ${td.tenant_access_token}`, "Content-Type": "application/json; charset=utf-8" };

  // Fetch all snapshot rows
  const snapshots = {};
  let pageToken;
  for (let p = 0; p < 50; p++) {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const data = await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${SNAPSHOT_TABLE_ID}/records/search`,
      { method: "POST", headers: h, body: JSON.stringify(body) }
    );
    for (const r of data.data.items || []) {
      const date = extractText(r.fields["日期"]).slice(0, 10);
      if (date) snapshots[date] = r.fields;
    }
    if (!data.data.has_more) break;
    pageToken = data.data.page_token;
  }
  console.log(`Snapshot table has rows for dates: ${Object.keys(snapshots).sort().join(", ")}\n`);

  const parseIds = (csv) => new Set((csv || "").split(",").map(s => s.trim()).filter(Boolean));

  const showDiff = (label, fieldName) => {
    const todayIds = parseIds(extractText(snapshots[TARGET_DATE]?.[fieldName]));
    const yestIds = parseIds(extractText(snapshots[yesterday]?.[fieldName]));
    const newIds = [...todayIds].filter(id => !yestIds.has(id));
    const removedIds = [...yestIds].filter(id => !todayIds.has(id));
    console.log(`=== ${label} (${fieldName}) ===`);
    console.log(`  ${yesterday}: ${yestIds.size} bugs`);
    console.log(`  ${TARGET_DATE}: ${todayIds.size} bugs (net change ${todayIds.size - yestIds.size})`);
    console.log(`  新加入 (今有昨没): ${newIds.length}`);
    console.log(`  移出 (昨有今没): ${removedIds.length}`);
    return { newIds, removedIds };
  };

  const u = showDiff("未解决", "未解决_ids");
  const p = showDiff("待验收", "待验收_ids");
  const r = showDiff("重新打开", "重新打开_ids");
  const c = showDiff("已关闭", "已关闭_ids");
  const t = showDiff("持续测试", "持续测试_ids");

  // Now fetch the descriptions for the "今变成未解决" bugs
  if (u.newIds.length > 0) {
    console.log(`\n=== "今天新变成未解决" 的 bug 详情 ===`);
    for (const bugId of u.newIds) {
      try {
        const data = await request(
          `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${BUG_TABLE_ID}/records/${bugId}`,
          { method: "GET", headers: h }
        );
        const desc = extractText(data.data.record.fields["问题描述"]);
        const status = extractText(data.data.record.fields["问题状态"]);
        console.log(`  ${bugId} [当前状态: ${status}]`);
        console.log(`    ${desc.slice(0, 120).replace(/\n/g, " ")}${desc.length > 120 ? "..." : ""}`);
      } catch (e) {
        console.log(`  ${bugId} [取详情失败: ${e.message}]`);
      }
    }
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });
