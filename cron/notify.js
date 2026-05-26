const FEISHU_API = "https://open.feishu.cn/open-apis";
const APP_ID = process.env.FEISHU_APP_ID || "cli_aa8445104379dcb3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "G4VNR37qVKcU80Zpa5axChb0EgaqCk1d";
const APP_TOKEN = "E8mgb7Zoxa0ZhLsND7wcOuxKnee";
const WEBHOOK_URL_ENV = process.env.FEISHU_WEBHOOK_URL;
const HISTORY_TABLE_NAME = "BugStats_History";
const SETTINGS_TABLE_NAME = "BugStats_Settings";

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
    return f ? (typeof f === "string" ? f : f.text || f.name || String(f)) : "";
  }
  if (typeof val === "object") return val.text || val.name || "";
  return String(val);
}

async function getTableIdByName(token, name) {
  const data = await request(`${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: "GET", headers: authHeaders(token),
  });
  const table = data.data.items.find((t) => t.name === name);
  return table ? table.table_id : null;
}

async function getWebhookFromSettings(token) {
  const tableId = await getTableIdByName(token, SETTINGS_TABLE_NAME);
  if (!tableId) return null;
  const data = await request(
    `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/search`,
    { method: "POST", headers: authHeaders(token), body: JSON.stringify({ page_size: 100 }) }
  ).catch(() => ({ data: { items: [] } }));
  for (const r of data.data.items || []) {
    if (extractText(r.fields["key"]) === "webhook_url") return extractText(r.fields["value"]);
  }
  return null;
}

async function fetchHistory(token, tableId) {
  const records = [];
  let pageToken = undefined;
  for (let page = 0; page < 50; page++) {
    const body = { page_size: 200 };
    if (pageToken) body.page_token = pageToken;
    const data = await request(
      `${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/search`,
      { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) }
    ).catch(() => ({ data: { items: [], has_more: false } }));
    for (const r of data.data.items || []) {
      const f = r.fields;
      const date = extractText(f["日期"]);
      if (!date || !date.includes("-")) continue;
      records.push({
        date: date.slice(0, 10),
        total: Number(f["总数"]) || 0,
        unresolved: Number(f["未解决"]) || 0,
        pending: Number(f["待验收"]) || 0,
        reopened: Number(f["重新打开"]) || 0,
        ratio: Number(f["占比(%)"]) || 0,
        testing: Number(f["持续测试"]) || 0,
        reviewing: Number(f["待评审"]) || 0,
        wontfix: Number(f["暂不修复"]) || 0,
        dupLink: Number(f["双连接"]) || 0,
        toUnresolved: Number(f["其他到未解决"]) || 0,
        toPending: Number(f["其他到待验收"]) || 0,
        toReopened: Number(f["其他到重新打开"]) || 0,
        toClosed: Number(f["其他到已关闭"]) || 0,
        toTesting: Number(f["其他到持续测试"]) || 0,
      });
    }
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  records.sort((a, b) => a.date.localeCompare(b.date));
  return records;
}

function buildVChartArea(values) {
  return {
    type: "area",
    data: [{ values }],
    xField: "date", yField: "count", seriesField: "type",
    stack: true,
    legends: {
      visible: true, position: "top", reverse: true,
      item: { shape: { style: { symbolType: "circle", size: 8 } }, label: { style: { fontSize: 10, fontWeight: "bold" } } },
    },
    color: ["#2DB87F", "#9CA3AF", "#F59F00", "#FF5C5C"],
    point: { visible: false },
    label: { visible: false },
    line: { style: { lineWidth: 1.5 } },
    area: { style: { fillOpacity: 0.35 } },
    tooltip: { visible: true, dimension: { visible: true } },
    crosshair: { xField: { visible: true } },
  };
}

function buildVChartLine(values, color) {
  return {
    type: "area",
    data: [{ values }],
    xField: "date", yField: "count", seriesField: "type",
    legends: {
      visible: true, position: "top",
      item: { shape: { style: { symbolType: "circle", size: 8, fill: color } }, label: { style: { fontSize: 10, fontWeight: "bold" } } },
    },
    color: [color],
    point: { visible: false },
    label: { visible: false },
    line: { style: { lineWidth: 2 } },
    area: { style: { fillOpacity: 0.12 } },
    tooltip: { visible: true, dimension: { visible: true } },
    crosshair: { xField: { visible: true } },
  };
}

function buildCard(latest, history) {
  const elements = [
    {
      tag: "column_set", flex_mode: "none", background_style: "grey",
      columns: [
        { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [
          { tag: "div", text: { tag: "lark_md", content: `**总数**\n<font color='blue'>**${latest.total}**</font>` } },
        ]},
        { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [
          { tag: "div", text: { tag: "lark_md", content: `**未解决**\n<font color='red'>**${latest.unresolved}**</font>` } },
        ]},
        { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [
          { tag: "div", text: { tag: "lark_md", content: `**重新打开**\n<font color='orange'>**${latest.reopened}**</font>` } },
        ]},
        { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [
          { tag: "div", text: { tag: "lark_md", content: `**占比**\n<font color='purple'>**${latest.ratio}%**</font>` } },
        ]},
      ],
    },
  ];

  const statusValues = [];
  for (const h of history) {
    const date = h.date.slice(5);
    const solving = h.unresolved + h.reopened;
    const verifying = h.pending + h.testing + h.reviewing;
    const other = h.wontfix + h.dupLink;
    const closed = Math.max(0, h.total - solving - verifying - other);
    statusValues.push(
      { date, count: closed, type: "已关闭" },
      { date, count: other, type: "其他" },
      { date, count: verifying, type: "验证中" },
      { date, count: solving, type: "解决中" },
    );
  }

  const charts = [
    buildVChartArea(statusValues),
    buildVChartLine(history.map((h) => ({ date: h.date.slice(5), count: h.ratio, type: "未解决占比(%)" })), "#E879A6"),
    buildVChartLine(history.map((h) => ({ date: h.date.slice(5), count: h.toUnresolved, type: "其他到未解决" })), "#FF5C5C"),
    buildVChartLine(history.map((h) => ({ date: h.date.slice(5), count: h.toReopened, type: "其他到重新打开" })), "#F59F00"),
    buildVChartLine(history.map((h) => ({ date: h.date.slice(5), count: h.toPending + h.toTesting, type: "其他到待验收+持续测试" })), "#B45BD5"),
    buildVChartLine(history.map((h) => ({ date: h.date.slice(5), count: h.toClosed, type: "其他到已关闭" })), "#2DB87F"),
  ];

  for (let row = 0; row < 2; row++) {
    elements.push({
      tag: "column_set", flex_mode: "none", horizontal_spacing: "small",
      columns: [0, 1, 2].map((col) => ({
        tag: "column", width: "weighted", weight: 1,
        elements: [{ tag: "chart", aspect_ratio: "4:3", chart_spec: charts[row * 3 + col] }],
      })),
    });
  }

  elements.push({ tag: "hr" });
  elements.push({
    tag: "note",
    elements: [{ tag: "plain_text", content: `统计日期：${latest.date}  ·  Sigma 耳机Bug Tracker` }],
  });

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "Sigma 耳机Bug Tracker" }, template: "blue" },
    elements,
  };
}

async function main() {
  console.log("=== Daily Bug Notification ===");
  const token = await getToken();

  const webhookUrl = await getWebhookFromSettings(token) || WEBHOOK_URL_ENV;
  if (!webhookUrl) {
    console.log("No webhook URL configured (neither in settings table nor env), skipping");
    return;
  }
  console.log(`Webhook source: ${webhookUrl.startsWith("http") ? "configured" : "unknown"}`);

  const tableId = await getTableIdByName(token, HISTORY_TABLE_NAME);
  if (!tableId) { console.log("History table not found"); return; }
  const history = await fetchHistory(token, tableId);
  if (history.length === 0) { console.log("No data"); return; }

  const latest = history[history.length - 1];
  console.log(`Latest: ${latest.date} total=${latest.total} unresolved=${latest.unresolved} pending=${latest.pending} reopened=${latest.reopened} ratio=${latest.ratio}%`);

  console.log("Building card with VChart specs...");
  const card = buildCard(latest, history);
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card }),
  });
  const result = await resp.json();
  if (result.code !== 0 && result.StatusCode !== 0) {
    throw new Error(`Webhook error: ${JSON.stringify(result)}`);
  }
  console.log("Notification sent!");
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
