// One-time setup: create the BugStats_DailyMatrix table.
// Schema:
//   - 记录ID  (text, type=1) — bug record_id, stable key
//   - 问题描述 (text, type=1) — human-readable bug title
// Date-named fields are added daily by cron/collect.js.

const FEISHU_API = "https://open.feishu.cn/open-apis";
const APP_ID = process.env.FEISHU_APP_ID || "cli_aa8445104379dcb3";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "G4VNR37qVKcU80Zpa5axChb0EgaqCk1d";
const APP_TOKEN = "E8mgb7Zoxa0ZhLsND7wcOuxKnee";
const MATRIX_TABLE_NAME = "BugStats_DailyMatrix";

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

async function findTable(token, name) {
  const data = await request(`${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: "GET", headers: authHeaders(token),
  });
  return data.data.items.find((t) => t.name === name) || null;
}

async function main() {
  const token = await getToken();

  const existing = await findTable(token, MATRIX_TABLE_NAME);
  if (existing) {
    console.log(`Table "${MATRIX_TABLE_NAME}" already exists (id=${existing.table_id}). Skipping creation.`);
    return;
  }

  const body = {
    table: {
      name: MATRIX_TABLE_NAME,
      fields: [
        { field_name: "记录ID", type: 1 },
        { field_name: "问题描述", type: 1 },
      ],
    },
  };
  const created = await request(`${FEISHU_API}/bitable/v1/apps/${APP_TOKEN}/tables`, {
    method: "POST", headers: authHeaders(token), body: JSON.stringify(body),
  });
  console.log(`Created table "${MATRIX_TABLE_NAME}" (id=${created.data.table_id})`);
}

main().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
