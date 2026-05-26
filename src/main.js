import { bitable } from "@lark-base-open/js-sdk";
import Chart from "chart.js/auto";

const HISTORY_TABLE_NAME = "BugStats_History";
const SETTINGS_TABLE_NAME = "BugStats_Settings";
const STATUS_FIELD = "问题状态";

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

async function fetchCurrentData() {
  const table = await bitable.base.getActiveTable();
  const fieldMetaList = await table.getFieldMetaList();
  const statusField = fieldMetaList.find((f) => f.name === STATUS_FIELD);

  if (!statusField) throw new Error(`找不到「${STATUS_FIELD}」字段`);

  let total = 0, unresolved = 0, pending = 0, reopened = 0;
  let testing = 0, reviewing = 0, wontfix = 0, dupLink = 0;
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
      if (status === "未复现，持续测试") testing++;
      if (status === "待评审") reviewing++;
      if (status === "暂不修复") wontfix++;
      if (status === "双连接，5月开始处理") dupLink++;
    }
    hasMore = resp.hasMore;
    pageToken = resp.pageToken;
  }

  const ratio = total > 0 ? parseFloat((((unresolved + reopened) / total) * 100).toFixed(1)) : 0;
  return { total, unresolved, pending, reopened, ratio, testing, reviewing, wontfix, dupLink };
}

async function getOrCreateHistoryTable() {
  const tables = await bitable.base.getTableList();
  for (const t of tables) {
    const name = await t.getName();
    if (name === HISTORY_TABLE_NAME) return t;
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
  return bitable.base.getTableById(tableId);
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
    const toUnresolvedField = f("其他到未解决");
    const toPendingField = f("其他到待验收");
    const toReopenedField = f("其他到重新打开");
    const toClosedField = f("其他到已关闭");
    const toTestingField = f("其他到持续测试");

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
          toUnresolved: toUnresolvedField ? Number(fields[toUnresolvedField.id]) || 0 : 0,
          toPending: toPendingField ? Number(fields[toPendingField.id]) || 0 : 0,
          toReopened: toReopenedField ? Number(fields[toReopenedField.id]) || 0 : 0,
          toClosed: toClosedField ? Number(fields[toClosedField.id]) || 0 : 0,
          toTesting: toTestingField ? Number(fields[toTestingField.id]) || 0 : 0,
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
  const verifying = history.map((h) => h.pending + h.testing + h.reviewing);
  const otherGroup = history.map((h) => h.wontfix + h.dupLink);
  const closedGroup = history.map((h, i) => Math.max(0, h.total - solving[i] - verifying[i] - otherGroup[i]));
  return { solving, verifying, otherGroup, closedGroup };
}

function stackedDatasets(layers) {
  return [
    { label: "已关闭", data: layers.closedGroup, borderColor: "#2DB87F", backgroundColor: "rgba(45,184,127,0.35)", fill: true, borderWidth: 1.5, pointRadius: 1, tension: 0 },
    { label: "其他", data: layers.otherGroup, borderColor: "#9CA3AF", backgroundColor: "rgba(156,163,175,0.35)", fill: true, borderWidth: 1.5, pointRadius: 1, tension: 0 },
    { label: "验证中", data: layers.verifying, borderColor: "#F59F00", backgroundColor: "rgba(245,159,0,0.35)", fill: true, borderWidth: 1.5, pointRadius: 1, tension: 0 },
    { label: "解决中", data: layers.solving, borderColor: "#FF5C5C", backgroundColor: "rgba(255,92,92,0.35)", fill: true, borderWidth: 1.5, pointRadius: 1, tension: 0 },
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

  const unresolvedData = [ds("其他到未解决", history.map((h) => h.toUnresolved), "#FF5C5C")];
  newUnresolvedChart = createLineChart("newUnresolvedChart", labels, unresolvedData, { title: "数量" });
  chartConfigs.newUnresolved = { title: "每日新增未解决", labels, yTitle: "数量", datasets: unresolvedData };

  const reopenedData = [ds("其他到重新打开", history.map((h) => h.toReopened), "#F59F00")];
  newReopenedChart = createLineChart("newReopenedChart", labels, reopenedData, { title: "数量" });
  chartConfigs.newReopened = { title: "每日新增重新打开", labels, yTitle: "数量", datasets: reopenedData };

  const verifyData = [ds("其他到待验收+持续测试", history.map((h) => h.toPending + h.toTesting), "#B45BD5")];
  newVerifyChart = createLineChart("newVerifyChart", labels, verifyData, { title: "数量" });
  chartConfigs.newVerify = { title: "每日新增待验收+持续测试", labels, yTitle: "数量", datasets: verifyData };

  const closedData = [ds("其他到已关闭", history.map((h) => h.toClosed), "#2DB87F")];
  newClosedChart = createLineChart("newClosedChart", labels, closedData, { title: "数量" });
  chartConfigs.newClosed = { title: "每日新增已关闭", labels, yTitle: "数量", datasets: closedData };

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
    await saveSnapshot(data);
    setStatus(`已自动更新 · ${new Date().toLocaleTimeString()}`, "success");
    const history = await loadHistory();
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

document.getElementById("settingsBtn").addEventListener("click", async () => {
  settingsModal.classList.add("open");
  setSettingsStatus("");
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

refresh(false);
setInterval(() => refresh(true), 60000);
