#  Sigma 耳机Bug Tracker — 飞书多维表格插件

[![](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![](https://img.shields.io/badge/Platform-Feishu%20Bitable-blue.svg)](https://www.feishu.cn/)
[![](https://img.shields.io/badge/Status-Active-green.svg)](https://github.com/larry-plaud/SigmaBugTrackerForEarPhone)

## 📖 简介 | Introduction

**Sigma 耳机Bug Tracker** 是一款基于飞书多维表格的 Bug 数据追踪与可视化插件。它可以实时统计 Bug 状态分布、趋势变化，并通过群机器人 Webhook 每天自动推送包含交互式图表的数据卡片到飞书群聊。

无论是日常 Bug 管理、迭代质量追踪，还是团队汇报，本工具都能帮助团队快速掌握项目质量全貌。

## ✨ 核心特性 | Features

- **实时看板**：4 大核心指标一目了然 — 总数、未解决、重新打开、未解决占比。
- **6 张趋势图表**：Bug 状态分布（堆叠面积图）+ 5 张趋势折线图，点击可放大查看详细数据。
- **群机器人推送**：一键发送当前数据到飞书群，卡片内嵌 VChart 交互式图表，支持点击放大、Tooltip 查看。
- **每日自动推送**：GitHub Actions 定时任务，每天早上 9:03（北京时间）自动发送数据报告到群。
- **每日自动采集**：每天 23:59（北京时间）自动采集 Bug 数据，计算状态流转（基于集合差异），写入历史表。
- **历史数据回填**：一键从原始 Bug 记录重建完整历史数据，基于创建时间 / 解决日期 / 流转时间推算每日状态。
- **插件内设置**：侧边栏设置面板，配置 Webhook 地址并持久化到多维表格。

## 📁 项目结构 | Project Structure

```
.
├── index.html                          # 插件主页面
├── src/
│   ├── main.js                         # 插件核心逻辑（数据获取、图表渲染、Webhook 发送）
│   └── style.css                       # 样式文件
├── cron/
│   ├── collect.js                      # 每日数据采集脚本
│   ├── notify.js                       # 每日群通知脚本
│   ├── backfill.js                     # 历史数据回填脚本
│   └── run-collect.bat                 # Windows 本地运行采集脚本
├── .github/workflows/
│   ├── collect.yml                     # GitHub Actions: 每日采集 (UTC 15:59 = 北京 23:59)
│   └── notify.yml                      # GitHub Actions: 每日通知 (UTC 01:03 = 北京 09:03)
├── vite.config.js                      # Vite 构建配置
├── package.json                        # 项目依赖
└── .gitignore
```

## 🚀 快速开始 | Quick Start

### 1. 环境要求

- [Node.js](https://nodejs.org/) >= 18
- 飞书多维表格 + 已安装本插件
- 飞书自建应用（拥有多维表格读写权限）
- 飞书群自定义机器人 Webhook 地址（用于推送通知）

### 2. 安装依赖

```bash
npm install
```

### 3. 本地开发

```bash
npm run dev
```

打开飞书多维表格插件调试页面，将地址指向本地开发服务器即可。

### 4. 构建部署

```bash
npm run build
```

构建产物输出到 `dist/` 目录。

## 📊 图表说明 | Charts

### 插件端（Chart.js）

插件侧边栏内渲染 6 张交互式图表，点击任意图表可侧滑放大查看：

| 图表 | 类型 | 说明 |
| :--- | :--- | :--- |
| Bug 状态分布 | 堆叠面积图 | 已关闭 / 其他 / 验证中 / 解决中 |
| 未解决占比趋势 | 折线图 | 百分比趋势 |
| 每日新增未解决 | 折线图 | 其他状态 → 未解决 |
| 每日新增重新打开 | 折线图 | 其他状态 → 重新打开 |
| 每日新增待验收+持续测试 | 折线图 | 其他状态 → 待验收/持续测试 |
| 每日新增已关闭 | 折线图 | 其他状态 → 已关闭 |

### 群消息卡片（VChart）

通过飞书 Webhook 发送的交互式卡片，内嵌 VChart 图表元素，**3×2 网格布局**：

- 小图模式：清晰展示趋势走势，带坐标轴和彩色圆点图例
- 点击放大：查看完整尺寸图表，触摸/悬停显示 Tooltip（日期 + 图标 + 系列名 + 数值）

## 定时任务 | Cron Jobs

### `cron/collect.js` — 每日数据采集

> 运行时间：每天 23:59 北京时间（UTC 15:59）

通过飞书 Open API 获取所有 Bug 记录，统计当前状态分布，与昨日快照进行集合差异计算，得出每日状态流转数据，写入 `BugStats_History` 表。

### `cron/notify.js` — 每日群通知

> 运行时间：每天 09:03 北京时间（UTC 01:03）

从 `BugStats_History` 读取历史数据，构建飞书交互式卡片（4 个指标卡 + 6 张 VChart 图表），发送到配置的 Webhook 地址。

### `cron/backfill.js` — 历史数据回填

> 手动运行（一次性）

从原始 Bug 记录重建完整历史，根据创建时间、解决日期、最近流转时间推算每日状态分布，批量写入历史表。适用于首次初始化或数据修复。

## ⚙️ 配置说明 | Configuration

### GitHub Actions Secrets

| Secret | 说明 |
| :--- | :--- |
| `FEISHU_APP_ID` | 飞书自建应用 App ID |
| `FEISHU_APP_SECRET` | 飞书自建应用 App Secret |
| `FEISHU_WEBHOOK_URL` | 飞书群机器人 Webhook 地址（备用，Settings 表优先） |

### Webhook 地址配置

Webhook 地址支持两种配置方式（按优先级）：

1. **插件设置面板**：点击插件右上角 **`⚙ 设置`** → 输入 Webhook 地址 → **`保存`**，数据持久化到 `BugStats_Settings` 表。
2. **环境变量**：在 GitHub Actions Secrets 中设置 `FEISHU_WEBHOOK_URL`，作为 fallback。

### 多维表格数据表

插件会自动创建以下 3 张表：

| 表名 | 用途 |
| :--- | :--- |
| `BugStats_History` | 每日聚合指标（总数、未解决、待验收、重新打开、占比、状态流转） |
| `BugStats_Snapshot` | 每日记录级快照（用于集合差异计算状态流转） |
| `BugStats_Settings` | Key-Value 配置存储（Webhook 地址等） |

## 技术栈 | Tech Stack

- **插件框架**: [Lark Base JS SDK](https://github.com/nicognaW/feishu-base-open-js-sdk) (`@lark-base-open/js-sdk`)
- **插件图表**: [Chart.js](https://www.chartjs.org/) v4
- **卡片图表**: [VChart](https://visactor.io/vchart)（飞书原生图表元素）
- **构建工具**: [Vite](https://vitejs.dev/) v6
- **定时任务**: GitHub Actions (Cron)
- **后端 API**: 飞书开放平台 Bitable API
- **开发语言**: JavaScript (ES Modules)

## 贡献指南 | Contributing

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建您的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交您的修改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启一个 Pull Request

---
