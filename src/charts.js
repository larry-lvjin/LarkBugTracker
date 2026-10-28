import Chart from 'chart.js/auto';
import { METRICS } from './config.js';
import { QUALITY } from './stats.js';

Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.color = '#8190a5';

function line(label, color, data) {
  return { label, data, borderColor: color, backgroundColor: color, borderWidth: 2,
    pointRadius: 2.5, pointHoverRadius: 5, pointHitRadius: 12, tension: 0, fill: false, spanGaps: false };
}
export function stockConfig(rows) {
  return {
    title: '每日状态总量', dates: rows.map(row => row.date),
    datasets: [line('未解决＋重新打开', '#e75b65', rows.map(row => row.open)), line('待验收', '#8b63d9', rows.map(row => row.pending))],
    tooltip: index => {
      const row = rows[index];
      return row.source === 'live' ? ['主表实时读取值'] : [row.conflict ? '同日历史冲突，冲突值不绘制' : '原历史表记录；采集时点和范围未验证'];
    },
  };
}
export function incomingConfig(rows) {
  return {
    title: '每日新增状态变化', dates: rows.map(row => row.date),
    datasets: METRICS.map(metric => line(metric.label, metric.color, rows.map(row => row.metrics[metric.key].value))),
    valueLabel: (index, datasetIndex) => {
      const metric = METRICS[datasetIndex];
      const cell = rows[index].metrics[metric.key];
      const ids = cell.items.map(item => [...item.bugNumbers].join('/') || item.recordId);
      return `${metric.label}：${cell.value}${ids.length ? ` (${ids.slice(0, 8).join('、')}${ids.length > 8 ? '…' : ''})` : ''}`;
    },
    tooltip: (index, datasetIndex) => {
      const cell = rows[index].metrics[METRICS[datasetIndex].key];
      return [QUALITY[cell.quality], cell.partial ? '2026-10-27 23:09 起，首日非完整自然日' : '按已读日志去重，不是自动化完整性证明', '点击查看 Bug 明细'];
    },
  };
}
export function drawChart(canvas, config, onSelect) {
  return new Chart(canvas, {
    type: 'line',
    data: { labels: config.dates, datasets: config.datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
      interaction: { mode: 'nearest', intersect: false },
      onClick(_event, elements) {
        if (elements.length) onSelect?.(config.dates[elements[0].index], elements[0].datasetIndex);
      },
      plugins: {
        legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, padding: 19, font: { size: 11 } } },
        tooltip: { backgroundColor: '#26354bef', padding: 11, displayColors: true, callbacks: {
          title: items => config.dates[items[0]?.dataIndex],
          label: context => config.valueLabel ? config.valueLabel(context.dataIndex, context.datasetIndex) : `${context.dataset.label}：${context.parsed.y} 个`,
          afterBody: items => items.length ? config.tooltip(items[0].dataIndex, items[0].datasetIndex) : [],
        } },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { maxTicksLimit: 9, maxRotation: 45, minRotation: 0, callback(_value, index) { return config.dates[index]?.slice(5); } } },
        y: { beginAtZero: true, suggestedMax: 1, border: { display: false }, grid: { color: '#edf0f6' }, ticks: { precision: 0, maxTicksLimit: 6 } },
      },
    },
  });
}
