# 侦探档案馆

一个面向推理爱好者的侦探作品图鉴、阅读记录与交流社区。产品采用原创品牌定位，以公开书目信息和正版外链连接读者与经典推理作品。

## 当前版本

`v0.1.0` 是 MVP 基础版本，已经包含：

- 原生微信小程序：首页、档案搜索、侦探详情。
- TypeScript API：健康检查、侦探列表、关键词筛选、分页、详情查询。
- 三位演示侦探及代表作品数据。
- 第 1～108 卷名侦探图鉴索引，共 109 条记录（含第 105 卷特装版）。
- 20 位图鉴之外的知名虚构侦探，以及 3 位独立展示的历史断案人物。
- PostgreSQL 完整数据模型蓝图。
- 产品 PRD、页面规划和技术架构文档。
- API 自动化测试。

登录、书架、评论、运营后台、内容审核和 AI 视频仍属于后续实现范围，详见 `docs/PRD-v0.1.md`。

## 项目结构

```text
apps/
  api/             TypeScript + Fastify API
  miniprogram/     原生微信小程序
database/
  schema.sql       PostgreSQL 数据模型蓝图
docs/
  PRD-v0.1.md      完整 MVP 产品需求文档
  architecture.md  技术架构与安全边界
  page-map.md      页面和交互规划
```

## 本地运行

### 1. 安装依赖

```bash
npm install
```

### 2. 启动 API

```bash
npm run dev:api
```

默认地址为 `http://127.0.0.1:3000`，可访问：

- `GET /health`
- `GET /api/v1/detectives`
- `GET /api/v1/detectives?q=波洛`
- `GET /api/v1/detectives/sherlock-holmes`
- `GET /api/v1/picture-book?pageSize=150`
- `GET /api/v1/picture-book?q=鲁邦`
- `GET /api/v1/picture-book/PB-105-SP`
- `GET /api/v1/archive-directory?collection=ARCHIVE_EXTENSION&pageSize=50`
- `GET /api/v1/archive-directory?collection=HISTORICAL_CASES&pageSize=50`
- `GET /api/v1/archive-directory/EXT-CN-001`

### 3. 打开小程序

使用微信开发者工具导入仓库根目录。开发阶段使用游客 AppID，接口地址由 `apps/miniprogram/app.js` 中的 `apiBaseUrl` 控制。

接入真实小程序前，需要替换 `project.config.json` 中的 AppID，并为生产环境配置合法的 HTTPS API 域名。

## 质量检查

```bash
npm run check
```

该命令依次执行类型检查、API 测试和生产构建。

图鉴与扩展目录数据的来源、编号和核验状态见 `docs/data-sources.md`。如需从公开索引重新生成 1～100 卷事实字段，可执行：

```bash
npm run catalog:sync
```

## 品牌与内容原则

- “侦探档案馆”是独立原创产品，不宣称与《名侦探柯南》官方有关联。
- 未取得授权时，不使用其角色形象、漫画插图、图鉴原文或官方视觉资产。
- 书籍与影视链接只接入出版社、正规电商、图书馆或正版视频平台。
- AI 创作优先支持原创人物和原创剧情，生成内容须经过安全审核后发布。
