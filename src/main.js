import { bitable } from "@lark-base-open/js-sdk";
import Chart from "chart.js/auto";
import * as XLSX from "xlsx";

const HISTORY_TABLE_NAME = "BugStats_History";
const SETTINGS_TABLE_NAME = "BugStats_Settings";
const STATUS_FIELD = "问题状态";
const TRANSITION_START_DATE = "2026-06-03";

let statusAreaChart = null;
let ratioChart = null;
let newUnresolvedChart = null;
let newReopenedChart = null;
let newVerifyChart = null;
let newClosedChart = null;
let modalChart = null;
const chartConfigs = {};

function setStatus(msg, type = "") {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = `status ${type}`;
}

function updateCards(total, unresolved, reopened, ratio) {
  document.getElementById("totalValue").textContent = total;
  document.getElementById("unresolvedValue").textContent = unresolved;
  document.getElementById("reopenedValue").textContent = reopened;
  document.getElementById("ratioValue").textContent = ratio + "%";
  document.getElementById("cards").classList.remove("loading");
}

function extractSelectValue(cellValue) {
  if (cellValue == null) return "";
  if (typeof cellValue === "string") return cellValue;
  if (typeof cellValue === "object" && cellValue.text) return cellValue.text;
  if (typeof cellValue === "object" && cellValue.name) return cellValue.name;
  if (Array.isArray(cellValue)) {
    const first = cellValue[0];
    if (!first) return "";
    if (typeof first === "string") return first;
    return first.text || first.name || String(first);
  }
  return String(cellValue);
}

function extractCellText(cellValue) {
  if (cellValue == null) return "";
  if (typeof cellValue === "string") return cellValue;
  if (typeof cellValue === "number") {
    if (cellValue > 1e12) {
      const d = new Date(cellValue);
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    return String(cellValue);
  }
  if (Array.isArray(cellValue)) {
    const first = cellValue[0];
    if (!first) return "";
    if (typeof first === "string") return first;
    if (typeof first === "object") return first.text || first.name || JSON.stringify(first);
    return String(first);
  }
  if (typeof cellValue === "object") {
    return cellValue.text || cellValue.name || cellValue.value || JSON.stringify(cellValue);
  }
  return String(cellValue);
}

async function findBugTable() {
  const active = await bitable.base.getActiveTable();
  const activeFields = await active.getFieldMetaList();
  if (activeFields.some((f) => f.name === STATUS_FIELD)) {
    return { table: active, fieldMetaList: activeFields };
  }
  const tables = await bitable.base.getTableList();
  for (const t of tables) {
    const fieldMetaList = await t.getFieldMetaList();
    if (fieldMetaList.some((f) => f.name === STATUS_FIELD)) {
      return { table: t, fieldMetaList };
    }
  }
  return null;
}

async function fetchCurrentData() {
  const found = await findBugTable();
  if (!found) throw new Error(`找不到包含「${STATUS_FIELD}」字段的表`);
  const { table, fieldMetaList } = found;
  const statusField = fieldMetaList.find((f) => f.name === STATUS_FIELD);

  let total = 0, unresolved = 0, pending = 0, reopened = 0;
  let testing = 0, reviewing = 0, wontfix = 0, dupLink = 0;
  let byDesign = 0, closed = 0, invalid = 0, testingOld = 0, tempVerify = 0, needLog = 0, fixedPending = 0;
  let pageToken = undefined;
  let hasMore = true;

  while (hasMore) {
    const resp = await table.getRecordsByPage({ pageSize: 200, pageToken });
    for (const record of resp.records) {
      total++;
      const status = extractSelectValue(record.fields[statusField.id]);
      if (status === "未解决") unresolved++;
      if (status === "待验收") pending++;
      if (status === "重新打开") reopened++;
      if (status === "已回归，持续测试") testing++;
      if (status === "待评审") reviewing++;
      if (status === "暂不修复") wontfix++;
      if (status === "双连接，5月份开始处理") dupLink++;
      if (status === "设计如此") byDesign++;
      if (status === "已关闭") closed++;
      if (status === "无效问题") invalid++;
      if (status === "未复现，持续测试") testingOld++;
      if (status === "临时版本验证") tempVerify++;
      if (status === "需补充日志") needLog++;
      if (status === "已修复，待发版") fixedPending++;
    }
    hasMore = resp.hasMore;
    pageToken = resp.pageToken;
  }

  const ratio = total > 0 ? parseFloat((((unresolved + reopened) / total) * 100).toFixed(1)) : 0;
  return { total, unresolved, pending, reopened, ratio, testing, reviewing, wontfix, dupLink, byDesign, closed, invalid, testingOld, tempVerify, needLog, fixedPending };
}

const REQUIRED_HISTORY_FIELDS = [
  "日期", "总数", "未解决", "待验收", "重新打开", "占比(%)",
  "持续测试", "待评审", "暂不修复", "双连接",
  "设计如此", "已关闭", "无效问题", "未复现持续测试", "临时版本验证", "需补充日志", "已修复，待发版",
  "其他到未解决", "其他到待验收", "其他到重新打开", "其他到已关闭", "其他到持续测试", "其他到未复现持续测试",
];

async function getOrCreateHistoryTable() {
  const tables = await bitable.base.getTableList();
  for (const t of tables) {
    const name = await t.getName();
    if (name === HISTORY_TABLE_NAME) {
      await ensureHistoryFields(t);
      return t;
    }
  }
  const { tableId } = await bitable.base.addTable({
    name: HISTORY_TABLE_NAME,
    fields: [
      { name: "日期", type: 1 },
      { name: "总数", type: 2 },
      { name: "未解决", type: 2 },
      { name: "待验收", type: 2 },
      { name: "重新打开", type: 2 },
      { name: "占比(%)", type: 2 },
    ],
  });
  const table = await bitable.base.getTableById(tableId);
  await ensureHistoryFields(table);
  return table;
}

async function ensureHistoryFields(table) {
  const fieldMeta = await table.getFieldMetaList();
  const existing = new Set(fieldMeta.map((f) => f.name));
  for (const name of REQUIRED_HISTORY_FIELDS) {
    if (!existing.has(name)) {
      const fieldType = name === "日期" ? 1 : 2;
      await table.addField({ type: fieldType, name });
    }
  }
}

async function loadHistory() {
  try {
    const histTable = await getOrCreateHistoryTable();
    const fieldMeta = await histTable.getFieldMetaList();
    const f = (name) => fieldMeta.find((m) => m.name === name);
    const dateField = f("日期");
    const totalField = f("总数");
    const unresolvedField = f("未解决");
    const pendingField = f("待验收");
    const ratioField = f("占比(%)");
    const reopenField = f("重新打开");
    const testingField = f("持续测试");
    const reviewingField = f("待评审");
    const wontfixField = f("暂不修复");
    const dupLinkField = f("双连接");
    const byDesignField = f("设计如此");
    const closedField = f("已关闭");
    const invalidField = f("无效问题");
    const testingOldField = f("未复现持续测试");
    const tempVerifyField = f("临时版本验证");
    const needLogField = f("需补充日志");
    const missingField = f("已修复，待发版");
    const toUnresolvedField = f("其他到未解决");
    const toPendingField = f("其他到待验收");
    const toReopenedField = f("其他到重新打开");
    const toClosedField = f("其他到已关闭");
    const toTestingField = f("其他到持续测试");
    const toTestingOldField = f("其他到未复现持续测试");

    if (!dateField || !totalField) return [];

    const history = [];
    let pageToken = undefined;
    let hasMore = true;

    while (hasMore) {
      const resp = await histTable.getRecordsByPage({ pageSize: 200, pageToken });
      for (const record of resp.records) {
        const fields = record.fields;
        const dateVal = extractCellText(fields[dateField.id]);
        if (!dateVal || !dateVal.includes("-")) continue;
        history.push({
          date: dateVal.slice(0, 10),
          total: Number(fields[totalField?.id]) || 0,
          unresolved: unresolvedField ? Number(fields[unresolvedField.id]) || 0 : 0,
          pending: pendingField ? Number(fields[pendingField.id]) || 0 : 0,
          reopened: reopenField ? Number(fields[reopenField.id]) || 0 : 0,
          ratio: ratioField ? Number(fields[ratioField.id]) || 0 : 0,
          testing: testingField ? Number(fields[testingField.id]) || 0 : 0,
          reviewing: reviewingField ? Number(fields[reviewingField.id]) || 0 : 0,
          wontfix: wontfixField ? Number(fields[wontfixField.id]) || 0 : 0,
          dupLink: dupLinkField ? Number(fields[dupLinkField.id]) || 0 : 0,
          byDesign: byDesignField ? Number(fields[byDesignField.id]) || 0 : 0,
          closed: closedField ? Number(fields[closedField.id]) || 0 : 0,
          invalid: invalidField ? Number(fields[invalidField.id]) || 0 : 0,
          testingOld: testingOldField ? Number(fields[testingOldField.id]) || 0 : 0,
          tempVerify: tempVerifyField ? Number(fields[tempVerifyField.id]) || 0 : 0,
          needLog: needLogField ? Number(fields[needLogField.id]) || 0 : 0,
          missing: missingField ? Number(fields[missingField.id]) || 0 : 0,
          toUnresolved: toUnresolvedField ? Number(fields[toUnresolvedField.id]) || 0 : 0,
          toPending: toPendingField ? Number(fields[toPendingField.id]) || 0 : 0,
          toReopened: toReopenedField ? Number(fields[toReopenedField.id]) || 0 : 0,
          toClosed: toClosedField ? Number(fields[toClosedField.id]) || 0 : 0,
          toTesting: toTestingField ? Number(fields[toTestingField.id]) || 0 : 0,
          toTestingOld: toTestingOldField ? Number(fields[toTestingOldField.id]) || 0 : 0,
        });
      }
      hasMore = resp.hasMore;
      pageToken = resp.pageToken;
    }

    history.sort((a, b) => a.date.localeCompare(b.date));
    return history;
  } catch (e) {
    console.error("Load history error:", e);
    return [];
  }
}

async function saveSnapshot(data) {
  const today = new Date().toISOString().slice(0, 10);
  const histTable = await getOrCreateHistoryTable();
  const fieldMeta = await histTable.getFieldMetaList();
  const f = (name) => fieldMeta.find((m) => m.name === name);
  const dateField = f("日期");
  const totalField = f("总数");
  const unresolvedField = f("未解决");
  const pendingField = f("待验收");
  const ratioField = f("占比(%)");
  const reopenedField = f("重新打开");

  let existingRecordId = null;
  let pageToken = undefined;
  let hasMore = true;

  while (hasMore) {
    const resp = await histTable.getRecordsByPage({ pageSize: 200, pageToken });
    for (const record of resp.records) {
      const dateVal = extractCellText(record.fields[dateField.id]);
      if (dateVal && dateVal.slice(0, 10) === today) {
        existingRecordId = record.recordId;
        break;
      }
    }
    if (existingRecordId) break;
    hasMore = resp.hasMore;
    pageToken = resp.pageToken;
  }

  const f2 = (name) => fieldMeta.find((m) => m.name === name);
  const testingF = f2("持续测试");
  const reviewingF = f2("待评审");
  const wontfixF = f2("暂不修复");
  const dupLinkF = f2("双连接");
  const byDesignF = f2("设计如此");
  const closedF = f2("已关闭");
  const invalidF = f2("无效问题");
  const testingOldF = f2("未复现持续测试");
  const tempVerifyF2 = f2("临时版本验证");
  const needLogF = f2("需补充日志");

  const recordFields = {
    [dateField.id]: today,
    [totalField.id]: data.total,
    [unresolvedField.id]: data.unresolved,
    [ratioField.id]: data.ratio,
  };
  if (pendingField) recordFields[pendingField.id] = data.pending;
  if (reopenedField) recordFields[reopenedField.id] = data.reopened;
  if (testingF) recordFields[testingF.id] = data.testing || 0;
  if (reviewingF) recordFields[reviewingF.id] = data.reviewing || 0;
  if (wontfixF) recordFields[wontfixF.id] = data.wontfix || 0;
  if (dupLinkF) recordFields[dupLinkF.id] = data.dupLink || 0;
  if (byDesignF) recordFields[byDesignF.id] = data.byDesign || 0;
  if (closedF) recordFields[closedF.id] = data.closed || 0;
  if (invalidF) recordFields[invalidF.id] = data.invalid || 0;
  if (testingOldF) recordFields[testingOldF.id] = data.testingOld || 0;
  if (tempVerifyF2) recordFields[tempVerifyF2.id] = data.tempVerify || 0;
  if (needLogF) recordFields[needLogF.id] = data.needLog || 0;

  if (existingRecordId) {
    await histTable.setRecord(existingRecordId, { fields: recordFields });
  } else {
    await histTable.addRecord({ fields: recordFields });
  }
}

async function getOrCreateSettingsTable() {
  const tables = await bitable.base.getTableList();
  for (const t of tables) {
    const name = await t.getName();
    if (name === SETTINGS_TABLE_NAME) return t;
  }
  const { tableId } = await bitable.base.addTable({
    name: SETTINGS_TABLE_NAME,
    fields: [
      { name: "key", type: 1 },
      { name: "value", type: 1 },
    ],
  });
  return bitable.base.getTableById(tableId);
}

async function loadWebhookUrl() {
  try {
    const table = await getOrCreateSettingsTable();
    const fieldMeta = await table.getFieldMetaList();
    const keyField = fieldMeta.find((f) => f.name === "key");
    const valueField = fieldMeta.find((f) => f.name === "value");
    if (!keyField || !valueField) return "";

    let pageToken = undefined;
    let hasMore = true;
    while (hasMore) {
      const resp = await table.getRecordsByPage({ pageSize: 200, pageToken });
      for (const record of resp.records) {
        const k = extractCellText(record.fields[keyField.id]);
        if (k === "webhook_url") return extractCellText(record.fields[valueField.id]);
      }
      hasMore = resp.hasMore;
      pageToken = resp.pageToken;
    }
    return "";
  } catch (e) {
    console.error("Load webhook URL error:", e);
    return "";
  }
}

async function saveWebhookUrl(url) {
  const table = await getOrCreateSettingsTable();
  const fieldMeta = await table.getFieldMetaList();
  const keyField = fieldMeta.find((f) => f.name === "key");
  const valueField = fieldMeta.find((f) => f.name === "value");

  let existingId = null;
  let pageToken = undefined;
  let hasMore = true;
  while (hasMore) {
    const resp = await table.getRecordsByPage({ pageSize: 200, pageToken });
    for (const record of resp.records) {
      const k = extractCellText(record.fields[keyField.id]);
      if (k === "webhook_url") { existingId = record.recordId; break; }
    }
    if (existingId) break;
    hasMore = resp.hasMore;
    pageToken = resp.pageToken;
  }

  const fields = { [keyField.id]: "webhook_url", [valueField.id]: url };
  if (existingId) {
    await table.setRecord(existingId, { fields });
  } else {
    await table.addRecord({ fields });
  }
}

function buildVChartArea(values, title) {
  return {
    type: "area",
    data: [{ values }],
    xField: "date", yField: "count", seriesField: "type",
    stack: true,
    title: { visible: true, text: title, textStyle: { fontSize: 14, fontWeight: "bold", fill: "#1f2329" } },
    legends: {
      visible: true, position: "top", reverse: true, padding: { top: 4 },
      item: { shape: { style: { symbolType: "circle", size: 10 } }, label: { style: { fontSize: 11 } } },
    },
    color: ["#2DB87F", "#9CA3AF", "#F59F00", "#FF5C5C"],
    point: { visible: false },
    label: { visible: false },
    line: { style: { lineWidth: 1.5 } },
    area: { style: { fillOpacity: 1 } },
    axes: [
      { orient: "left", title: { visible: true, text: "数量", style: { fontSize: 10, fill: "#8f959e" } }, label: { style: { fontSize: 9, fill: "#8f959e" } }, grid: { visible: true, style: { lineDash: [], stroke: "#f0f1f3" } } },
      { orient: "bottom", label: { style: { fontSize: 9, fill: "#8f959e" } }, grid: { visible: false } },
    ],
    tooltip: { visible: true, dimension: { visible: true } },
    crosshair: { xField: { visible: true } },
  };
}

function buildVChartLine(values, color, title, yLabel) {
  return {
    type: "area",
    data: [{ values }],
    xField: "date", yField: "count", seriesField: "type",
    title: { visible: true, text: title, textStyle: { fontSize: 14, fontWeight: "bold", fill: "#1f2329" } },
    legends: {
      visible: true, position: "top", padding: { top: 4 },
      item: { shape: { style: { symbolType: "circle", size: 10, fill: color } }, label: { style: { fontSize: 11 } } },
    },
    color: [color],
    point: { visible: false },
    label: { visible: false },
    line: { style: { lineWidth: 2 } },
    area: { style: { fillOpacity: 0.12 } },
    axes: [
      { orient: "left", title: { visible: true, text: yLabel || "数量", style: { fontSize: 10, fill: "#8f959e" } }, label: { style: { fontSize: 9, fill: "#8f959e" } }, grid: { visible: true, style: { lineDash: [], stroke: "#f0f1f3" } } },
      { orient: "bottom", label: { style: { fontSize: 9, fill: "#8f959e" } }, grid: { visible: false } },
    ],
    tooltip: { visible: true, dimension: { visible: true } },
    crosshair: { xField: { visible: true } },
  };
}

function buildCardMessage(data, history) {
  const elements = [
    {
      tag: "column_set", flex_mode: "none", background_style: "grey",
      columns: [
        { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [
          { tag: "div", text: { tag: "lark_md", content: `**总数**\n<font color='blue'>**${data.total}**</font>` } },
        ]},
        { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [
          { tag: "div", text: { tag: "lark_md", content: `**未解决**\n<font color='red'>**${data.unresolved}**</font>` } },
        ]},
        { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [
          { tag: "div", text: { tag: "lark_md", content: `**重新打开**\n<font color='orange'>**${data.reopened}**</font>` } },
        ]},
        { tag: "column", width: "weighted", weight: 1, vertical_align: "center", elements: [
          { tag: "div", text: { tag: "lark_md", content: `**占比**\n<font color='purple'>**${data.ratio}%**</font>` } },
        ]},
      ],
    },
  ];

  const statusValues = [];
  for (const h of history) {
    const date = h.date.slice(5);
    const solving = h.unresolved + h.reopened;
    const verifying = h.pending + h.testing + h.testingOld + h.reviewing + h.tempVerify + h.needLog;
    const closed = h.byDesign + h.wontfix + h.closed + h.invalid + (h.missing || 0);
    const other = h.dupLink;
    statusValues.push(
      { date, count: closed, type: "已关闭" },
      { date, count: other, type: "其他" },
      { date, count: verifying, type: "验证中" },
      { date, count: solving, type: "解决中" },
    );
  }

  const th = history.filter((h) => h.date >= TRANSITION_START_DATE);
  const charts = [
    buildVChartArea(statusValues, "Bug 状态分布"),
    buildVChartLine(history.map((h) => ({ date: h.date.slice(5), count: h.ratio, type: "未解决占比(%)" })), "#E879A6", "未解决占比趋势", "%"),
    buildVChartLine(th.map((h) => ({ date: h.date.slice(5), count: h.toUnresolved, type: "未解决变化" })), "#FF5C5C", "未解决变化"),
    buildVChartLine(th.map((h) => ({ date: h.date.slice(5), count: h.toReopened, type: "重新打开变化" })), "#F59F00", "重新打开变化"),
    buildVChartLine(th.map((h) => ({ date: h.date.slice(5), count: h.toPending + h.toTesting + (h.toTestingOld || 0), type: "待验收+持续测试变化" })), "#B45BD5", "待验收+持续测试变化"),
    buildVChartLine(th.map((h) => ({ date: h.date.slice(5), count: h.toClosed, type: "已关闭变化" })), "#2DB87F", "已关闭变化"),
  ];

  const chartLabels = [
    "Bug 状态分布\n<font color='red'>⬤</font>解决中<font color='orange'>⬤</font>验证中<font color='grey'>⬤</font>其他<font color='green'>⬤</font>已关闭",
    "未解决占比趋势\n<font color='carmine'>⬤</font>占比(%)",
    "未解决变化\n<font color='red'>⬤</font>未解决变化",
    "重新打开变化\n<font color='orange'>⬤</font>重新打开变化",
    "待验收+持续测试变化\n<font color='purple'>⬤</font>待验收+持续测试变化",
    "已关闭变化\n<font color='green'>⬤</font>已关闭变化",
  ];

  for (let row = 0; row < 2; row++) {
    elements.push({
      tag: "column_set", flex_mode: "none", horizontal_spacing: "small",
      columns: [0, 1, 2].map((col) => {
        const idx = row * 3 + col;
        return {
          tag: "column", width: "weighted", weight: 1,
          elements: [
            { tag: "note", elements: [{ tag: "lark_md", content: chartLabels[idx] }] },
            { tag: "chart", aspect_ratio: "4:3", chart_spec: charts[idx] },
          ],
        };
      }),
    });
  }

  elements.push({ tag: "hr" });
  elements.push({ tag: "note", elements: [{ tag: "plain_text", content: `统计日期：${new Date().toISOString().slice(0, 10)}  ·  Sigma 耳机Bug Tracker` }] });

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: "Sigma 耳机Bug Tracker" }, template: "blue" },
      elements,
    },
  };
}

async function sendToWebhook(url, data, history) {
  const body = buildCardMessage(data, history);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await resp.json();
  if (result.code !== 0 && result.StatusCode !== 0) {
    throw new Error(result.msg || JSON.stringify(result));
  }
}

function makeLabels(history) {
  return history.map((h) => {
    const parts = h.date.split("-");
    return parts.length >= 3 ? `${parts[1]}-${parts[2]}` : h.date;
  });
}

function ds(label, data, color, opts = {}) {
  return {
    label, data,
    borderColor: color,
    backgroundColor: opts.fill ? color + "40" : "transparent",
    borderWidth: opts.borderWidth || 1.5,
    pointRadius: opts.pointRadius || 1.5,
    pointHoverRadius: 4,
    pointStyle: "circle",
    pointBackgroundColor: color,
    pointBorderColor: color,
    pointBorderWidth: 0,
    tension: 0,
    fill: opts.fill || false,
  };
}

function createLineChart(canvasId, labels, datasets, yConfig = {}) {
  return new Chart(document.getElementById(canvasId).getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { font: { size: 11, weight: "500" }, boxWidth: 8, boxHeight: 8, padding: 16, usePointStyle: true },
        },
        tooltip: {
          backgroundColor: "#fff", titleColor: "#1f2329", bodyColor: "#444",
          borderColor: "#e5e6e8", borderWidth: 1,
          titleFont: { size: 12, weight: "600" }, bodyFont: { size: 11 },
          padding: 10, cornerRadius: 6, boxPadding: 4, usePointStyle: true,
          ...(yConfig.tooltip || {}),
        },
      },
      scales: {
        x: {
          ticks: { font: { size: 9, weight: "400" }, maxRotation: 50, autoSkipPadding: 12, color: "#8f959e" },
          grid: { display: false }, border: { display: false },
        },
        y: {
          title: { display: true, text: yConfig.title || "", font: { size: 10 }, color: "#8f959e" },
          ticks: { font: { size: 9 }, color: "#8f959e", padding: 6, ...(yConfig.ticks || {}) },
          beginAtZero: true,
          grid: { color: "#f0f1f3", lineWidth: 0.8 }, border: { display: false },
          ...(yConfig.extra || {}),
        },
      },
    },
  });
}

function calcStackedLayers(history) {
  const solving = history.map((h) => h.unresolved + h.reopened);
  const verifying = history.map((h) => h.pending + h.testing + h.testingOld + h.reviewing + h.tempVerify + h.needLog);
  const closedGroup = history.map((h) => h.byDesign + h.wontfix + h.closed + h.invalid + (h.missing || 0));
  const otherGroup = history.map((h) => h.dupLink);
  return { solving, verifying, otherGroup, closedGroup };
}

function stackedDatasets(layers) {
  return [
    { label: "已关闭", data: layers.closedGroup, borderColor: "#2DB87F", backgroundColor: "#2DB87F", fill: true, borderWidth: 1.5, pointRadius: 1, tension: 0 },
    { label: "其他", data: layers.otherGroup, borderColor: "#9CA3AF", backgroundColor: "#9CA3AF", fill: true, borderWidth: 1.5, pointRadius: 1, tension: 0 },
    { label: "验证中", data: layers.verifying, borderColor: "#F59F00", backgroundColor: "#F59F00", fill: true, borderWidth: 1.5, pointRadius: 1, tension: 0 },
    { label: "解决中", data: layers.solving, borderColor: "#FF5C5C", backgroundColor: "#FF5C5C", fill: true, borderWidth: 1.5, pointRadius: 1, tension: 0 },
  ];
}

function createStackedAreaChart(canvasId, labels, history) {
  const layers = calcStackedLayers(history);
  return new Chart(document.getElementById(canvasId).getContext("2d"), {
    type: "line",
    data: { labels, datasets: stackedDatasets(layers) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top", reverse: true,
          labels: { font: { size: 11, weight: "500" }, boxWidth: 8, boxHeight: 8, padding: 16, usePointStyle: true },
        },
        tooltip: {
          backgroundColor: "#fff", titleColor: "#1f2329", bodyColor: "#444",
          borderColor: "#e5e6e8", borderWidth: 1,
          titleFont: { size: 12, weight: "600" }, bodyFont: { size: 11 },
          padding: 10, cornerRadius: 6, boxPadding: 4, usePointStyle: true,
        },
      },
      scales: {
        x: {
          ticks: { font: { size: 9 }, maxRotation: 50, autoSkipPadding: 12, color: "#8f959e" },
          grid: { display: false }, border: { display: false },
        },
        y: {
          stacked: true,
          title: { display: true, text: "数量", font: { size: 10 }, color: "#8f959e" },
          ticks: { font: { size: 9 }, color: "#8f959e", padding: 6 },
          beginAtZero: true,
          grid: { color: "#f0f1f3", lineWidth: 0.8 }, border: { display: false },
        },
      },
    },
  });
}

function openModal(key) {
  const cfg = chartConfigs[key];
  if (!cfg) return;
  const modal = document.getElementById("chartModal");
  document.getElementById("modalTitle").textContent = cfg.title;
  if (modalChart) { modalChart.destroy(); modalChart = null; }

  const oldCanvas = document.getElementById("modalChart");
  const newCanvas = document.createElement("canvas");
  newCanvas.id = "modalChart";
  oldCanvas.parentNode.replaceChild(newCanvas, oldCanvas);

  const xTicks = { font: { size: 10, weight: "500" }, maxRotation: 90, autoSkip: false, color: "#8f959e" };
  const yTicks = { font: { size: 11 }, color: "#8f959e", padding: 6, ...(cfg.yTicks || {}) };
  const tooltipExtra = cfg.tooltipCallbacks ? { callbacks: cfg.tooltipCallbacks } : {};

  const baseOpts = {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { position: "top", reverse: !!cfg.yExtra?.stacked, labels: { font: { size: 13, weight: "600" }, boxWidth: 10, boxHeight: 10, padding: 18, usePointStyle: true } },
      tooltip: {
        backgroundColor: "#fff", titleColor: "#1f2329", bodyColor: "#444",
        borderColor: "#e5e6e8", borderWidth: 1,
        titleFont: { size: 13, weight: "600" }, bodyFont: { size: 12 },
        padding: 12, cornerRadius: 6, boxPadding: 4, usePointStyle: true,
        ...tooltipExtra,
      },
    },
    scales: {
      x: { ticks: xTicks, grid: { display: false }, border: { display: false } },
      y: {
        title: { display: true, text: cfg.yTitle || "", font: { size: 12 }, color: "#8f959e" },
        ticks: yTicks, beginAtZero: true,
        grid: { color: "#f0f1f3", lineWidth: 0.8 }, border: { display: false },
        ...(cfg.yExtra || {}),
      },
    },
  };

  const clonedDatasets = cfg.datasets.map((d) => ({ ...d, data: [...d.data] }));
  modalChart = new Chart(newCanvas.getContext("2d"), {
    type: "line",
    data: { labels: [...cfg.labels], datasets: clonedDatasets },
    options: baseOpts,
  });
  modal.classList.add("open");
}

function closeModal() {
  document.getElementById("chartModal").classList.remove("open");
  if (modalChart) { modalChart.destroy(); modalChart = null; }
}

document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("chartModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeModal();
});

function renderCharts(history) {
  const labels = makeLabels(history);

  if (statusAreaChart) statusAreaChart.destroy();
  if (ratioChart) ratioChart.destroy();
  if (newUnresolvedChart) newUnresolvedChart.destroy();
  if (newReopenedChart) newReopenedChart.destroy();
  if (newVerifyChart) newVerifyChart.destroy();
  if (newClosedChart) newClosedChart.destroy();

  statusAreaChart = createStackedAreaChart("statusAreaChart", labels, history);
  {
    const layers = calcStackedLayers(history);
    chartConfigs.statusArea = {
      title: "Bug 状态分布", labels, yTitle: "数量",
      yExtra: { stacked: true },
      datasets: stackedDatasets(layers),
    };
  }

  const ratioData = [ds("未解决占比(%)", history.map((h) => h.ratio), "#E879A6")];
  ratioChart = createLineChart("ratioChart", labels, ratioData, {
    title: "%",
    ticks: { callback: (v) => v + "%" },
    extra: { suggestedMax: 100 },
    tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}%` } },
  });
  chartConfigs.ratio = {
    title: "未解决占比趋势", labels, yTitle: "%",
    datasets: ratioData,
    yTicks: { callback: (v) => v + "%" },
    yExtra: { suggestedMax: 100 },
    tooltipCallbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}%` },
  };

  const th = history.filter((h) => h.date >= TRANSITION_START_DATE);
  const tLabels = makeLabels(th);

  const unresolvedData = [ds("未解决变化", th.map((h) => h.toUnresolved), "#FF5C5C")];
  newUnresolvedChart = createLineChart("newUnresolvedChart", tLabels, unresolvedData, { title: "数量" });
  chartConfigs.newUnresolved = { title: "未解决变化", labels: tLabels, yTitle: "数量", datasets: unresolvedData };

  const reopenedData = [ds("重新打开变化", th.map((h) => h.toReopened), "#F59F00")];
  newReopenedChart = createLineChart("newReopenedChart", tLabels, reopenedData, { title: "数量" });
  chartConfigs.newReopened = { title: "重新打开变化", labels: tLabels, yTitle: "数量", datasets: reopenedData };

  const verifyData = [ds("待验收+持续测试变化", th.map((h) => h.toPending + h.toTesting + (h.toTestingOld || 0)), "#B45BD5")];
  newVerifyChart = createLineChart("newVerifyChart", tLabels, verifyData, { title: "数量" });
  chartConfigs.newVerify = { title: "待验收+持续测试变化", labels: tLabels, yTitle: "数量", datasets: verifyData };

  const closedData = [ds("已关闭变化", th.map((h) => h.toClosed), "#2DB87F")];
  newClosedChart = createLineChart("newClosedChart", tLabels, closedData, { title: "数量" });
  chartConfigs.newClosed = { title: "已关闭变化", labels: tLabels, yTitle: "数量", datasets: closedData };

  document.getElementById("historyInfo").textContent = `共 ${history.length} 条历史记录`;
}

let isRefreshing = false;
let latestData = null;
let latestHistory = [];

async function refresh(silent = false) {
  if (isRefreshing) return;
  isRefreshing = true;
  if (!silent) {
    setStatus("正在获取数据...");
    document.getElementById("cards").classList.add("loading");
  }
  try {
    const data = await fetchCurrentData();
    latestData = data;
    updateCards(data.total, data.unresolved, data.reopened, data.ratio);
    setStatus(`已自动更新 · ${new Date().toLocaleTimeString()}`, "success");
    const history = await loadHistory();

    const today = new Date().toISOString().slice(0, 10);
    const todayIdx = history.findIndex(h => h.date === today);
    const trackedSum = data.unresolved + data.reopened + data.pending + data.testing + data.testingOld +
      data.reviewing + data.wontfix + data.dupLink + data.byDesign + data.closed + data.invalid +
      data.tempVerify + data.needLog + data.fixedPending;
    const liveEntry = {
      date: today, total: data.total, unresolved: data.unresolved, pending: data.pending,
      reopened: data.reopened, ratio: data.ratio, testing: data.testing, reviewing: data.reviewing,
      wontfix: data.wontfix, dupLink: data.dupLink, byDesign: data.byDesign, closed: data.closed,
      invalid: data.invalid, testingOld: data.testingOld, tempVerify: data.tempVerify, needLog: data.needLog,
      missing: data.fixedPending + Math.max(0, data.total - trackedSum),
      toUnresolved: 0, toPending: 0, toReopened: 0, toClosed: 0, toTesting: 0, toTestingOld: 0,
    };
    if (todayIdx >= 0) {
      liveEntry.toUnresolved = history[todayIdx].toUnresolved;
      liveEntry.toPending = history[todayIdx].toPending;
      liveEntry.toReopened = history[todayIdx].toReopened;
      liveEntry.toClosed = history[todayIdx].toClosed;
      liveEntry.toTesting = history[todayIdx].toTesting;
      liveEntry.toTestingOld = history[todayIdx].toTestingOld;
      history[todayIdx] = liveEntry;
    } else {
      history.push(liveEntry);
    }

    latestHistory = history;
    if (history.length > 0) {
      renderCharts(history);
    } else {
      document.getElementById("historyInfo").textContent = "暂无历史数据";
    }
  } catch (e) {
    if (!silent) {
      setStatus(`错误: ${e.message}`, "error");
      document.getElementById("cards").classList.remove("loading");
    }
  } finally {
    isRefreshing = false;
  }
}

document.getElementById("refreshBtn").addEventListener("click", () => refresh(false));

document.querySelectorAll(".chart-section[data-chart]").forEach((el) => {
  el.addEventListener("click", () => openModal(el.dataset.chart));
});

const settingsModal = document.getElementById("settingsModal");
const webhookInput = document.getElementById("webhookInput");
const settingsStatusEl = document.getElementById("settingsStatus");

webhookInput.addEventListener("copy", (e) => e.preventDefault());
webhookInput.addEventListener("cut", (e) => e.preventDefault());

function setSettingsStatus(msg, type = "") {
  settingsStatusEl.textContent = msg;
  settingsStatusEl.className = `settings-status ${type}`;
}

function renderStatsTable(history) {
  const container = document.getElementById("statsTable");
  if (!history || history.length === 0) {
    container.innerHTML = "<div style='padding:12px;color:#8f959e;font-size:11px'>暂无数据</div>";
    return;
  }
  const rows = [...history].reverse();
  const cols = [
    { key: "date", label: "日期" },
    { key: "unresolved", label: "未解决" },
    { key: "reopened", label: "重新打开" },
    { key: "pending", label: "待验收" },
    { key: "testingOld", label: "未复现，持续测试" },
    { key: "reviewing", label: "待评审" },
    { key: "testing", label: "已回归，持续测试" },
    { key: "tempVerify", label: "临时版本验证" },
    { key: "needLog", label: "需补充日志" },
    { key: "dupLink", label: "双连接" },
    { key: "byDesign", label: "设计如此" },
    { key: "wontfix", label: "暂不修复" },
    { key: "closed", label: "已关闭" },
    { key: "invalid", label: "无效问题" },
    { key: "missing", label: "已修复，待发版" },
    { key: "total", label: "总数" },
  ];
  const thRow = cols.map((c) => `<th>${c.label}</th>`).join("");
  const bodyRows = rows.map((h) => {
    const vals = {
      date: h.date.slice(5), unresolved: h.unresolved, reopened: h.reopened,
      pending: h.pending, testingOld: h.testingOld, reviewing: h.reviewing,
      testing: h.testing, tempVerify: h.tempVerify, needLog: h.needLog,
      dupLink: h.dupLink, byDesign: h.byDesign, wontfix: h.wontfix,
      closed: h.closed, invalid: h.invalid, missing: h.missing || 0, total: h.total,
    };
    return "<tr>" + cols.map((c) => `<td>${vals[c.key]}</td>`).join("") + "</tr>";
  }).join("");
  container.innerHTML = `<table class="stats-table"><thead><tr>${thRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function exportExcel(history) {
  if (!history || history.length === 0) return;
  const headers = ["日期","未解决","重新打开","待验收","未复现，持续测试","待评审","已回归，持续测试","临时版本验证","需补充日志","双连接，5月份开始处理","设计如此","暂不修复","已关闭","无效问题","已修复，待发版","总数"];
  const rows = [...history].reverse().map((h) => [
    h.date, h.unresolved, h.reopened, h.pending, h.testingOld, h.reviewing,
    h.testing, h.tempVerify, h.needLog, h.dupLink, h.byDesign, h.wontfix,
    h.closed, h.invalid, h.missing || 0, h.total,
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const colWidths = [12, 8, 8, 8, 14, 8, 14, 10, 10, 16, 8, 8, 8, 8, 10, 8];
  ws["!cols"] = colWidths.map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Bug Stats");
  XLSX.writeFile(wb, `bug_stats_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

document.getElementById("settingsBtn").addEventListener("click", async () => {
  settingsModal.classList.add("open");
  setSettingsStatus("");
  renderStatsTable(latestHistory);
  try {
    const url = await loadWebhookUrl();
    webhookInput.value = url;
  } catch (e) {
    webhookInput.value = "";
  }
});

document.getElementById("settingsClose").addEventListener("click", () => {
  settingsModal.classList.remove("open");
});
settingsModal.addEventListener("click", (e) => {
  if (e.target === settingsModal) settingsModal.classList.remove("open");
});

document.getElementById("saveWebhookBtn").addEventListener("click", async () => {
  const url = webhookInput.value.trim();
  setSettingsStatus("保存中...");
  try {
    await saveWebhookUrl(url);
    setSettingsStatus("已保存", "success");
  } catch (e) {
    setSettingsStatus(`保存失败: ${e.message}`, "error");
  }
});

document.getElementById("sendNowBtn").addEventListener("click", async () => {
  const url = webhookInput.value.trim();
  if (!url) { setSettingsStatus("请先输入 Webhook 地址", "error"); return; }
  if (!latestData) { setSettingsStatus("数据未加载，请稍候", "error"); return; }
  setSettingsStatus("发送中...");
  try {
    await sendToWebhook(url, latestData, latestHistory);
    setSettingsStatus("发送成功", "success");
  } catch (e) {
    setSettingsStatus(`发送失败: ${e.message}`, "error");
  }
});

document.getElementById("exportBtn").addEventListener("click", () => exportExcel(latestHistory));

refresh(false);
setInterval(() => refresh(true), 60000);
