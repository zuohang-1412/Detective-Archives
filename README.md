# 侦探档案馆

一个面向推理爱好者的侦探作品图鉴、阅读记录与交流社区。产品采用原创品牌定位，以公开书目信息和正版外链连接读者与经典推理作品。

## 当前版本

`v0.1.0` 是 MVP 基础版本，已经包含：

- 原生微信小程序：首页、档案搜索、侦探详情、作品详情与正版渠道。
- TypeScript API：健康检查、数据库仓储、侦探/图鉴/扩展目录/作品查询。
- 三位演示侦探及代表作品数据。
- 第 1～108 卷名侦探图鉴索引，共 109 条记录（含第 105 卷特装版）。
- 20 位图鉴之外的知名虚构侦探，以及 3 位独立展示的历史断案人物。
- PostgreSQL 运行时连接、增量迁移、目录初始化、作品与正版链接仓储和完整性检查。
- 微信 `code2Session` 服务端身份、不可逆会话令牌、退出登录和个人书架进度。
- 短评/长评、剧透折叠、回复、点赞、举报、作者软删除和默认待审核流程。
- 内置运营后台：独立管理员登录、数据概览、评价/回复审核、举报处理、用户处置、作品与正版链接维护。
- 产品 PRD、页面规划和技术架构文档。
- API 自动化测试。

侦探资料维护深化、上线基础设施和 AI 视频仍属于后续实现范围，详见 `docs/PRD-v0.1.md`。

## 项目结构

```text
apps/
  api/             TypeScript + Fastify API
  miniprogram/     原生微信小程序
database/
  schema.sql       PostgreSQL 不可变初始结构迁移
  migrations/      后续增量迁移
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

### 2. 初始化数据库

配置 `DATABASE_URL`，或配置 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSWORD` 和 `PGSSLMODE`。首次创建独立数据库并导入目录：

```bash
npm run db:setup
```

默认创建 `detective_archives`；可通过 `DETECTIVE_DB_NAME` 修改。初始化完成后，API 的 `DATABASE_URL` 或 `PGDATABASE` 需要指向该数据库。

真实微信登录需同时配置 `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`。本地联调可设置 `WECHAT_DEV_LOGIN=true`，但服务会拒绝在 `NODE_ENV=production` 时启用开发身份。

运营后台需同时配置 `ADMIN_LOGIN_ID` 和 `ADMIN_LOGIN_PASSWORD`；生产密码至少 16 位。启动 API 后访问 `/admin/`，后台令牌仅保存在当前浏览器会话中。

### 3. 启动 API

```bash
npm run dev:api
```

默认地址为 `http://127.0.0.1:3000`，可访问：

- `GET /health`
- `GET /ready`
- `GET /api/v1/detectives`
- `GET /api/v1/detectives?q=波洛`
- `GET /api/v1/detectives/sherlock-holmes`
- `GET /api/v1/picture-book?pageSize=150`
- `GET /api/v1/picture-book?q=鲁邦`
- `GET /api/v1/picture-book/PB-105-SP`
- `GET /api/v1/archive-directory?collection=ARCHIVE_EXTENSION&pageSize=50`
- `GET /api/v1/archive-directory?collection=HISTORICAL_CASES&pageSize=50`
- `GET /api/v1/archive-directory/EXT-CN-001`
- `GET /api/v1/works?pageSize=20`
- `GET /api/v1/works?q=东方快车`
- `GET /api/v1/works/murder-on-the-orient-express`
- `POST /api/v1/auth/wechat`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/logout`
- `GET /api/v1/me/shelf`
- `PUT /api/v1/me/shelf/:workId`
- `DELETE /api/v1/me/shelf/:workId`
- `GET|POST /api/v1/works/:workId/reviews`
- `GET|PATCH|DELETE /api/v1/reviews/:reviewId`
- `POST /api/v1/reviews/:reviewId/comments`
- `PUT|DELETE /api/v1/reviews/:reviewId/like`
- `PUT|DELETE /api/v1/comments/:commentId/like`
- `POST /api/v1/reports`
- `POST /api/v1/auth/admin`
- `GET /api/v1/admin/dashboard`
- `GET /api/v1/admin/moderation`
- `POST /api/v1/admin/moderation/:targetType/:targetId`
- `PATCH /api/v1/admin/reports/:reportId`
- `GET|POST /api/v1/admin/works`
- `POST /api/v1/admin/works/:workId/links`

### 4. 打开小程序

使用微信开发者工具导入仓库根目录。开发阶段使用游客 AppID，接口地址由 `apps/miniprogram/app.js` 中的 `apiBaseUrl` 控制。

接入真实小程序前，需要替换 `project.config.json` 中的 AppID，并为生产环境配置合法的 HTTPS API 域名。

## 质量检查

```bash
npm run check
```

该命令依次执行类型检查、API 测试和生产构建。

连接数据库后可执行真实数据完整性检查：

```bash
npm run check:db
npm run check:db-api
```

第二条命令会通过真实 PostgreSQL 仓储检查六条公开 API 主链路，执行前需要先完成生产构建。

图鉴与扩展目录数据的来源、编号和核验状态见 `docs/data-sources.md`。如需从公开索引重新生成 1～100 卷事实字段，可执行：

```bash
npm run catalog:sync
```

## 品牌与内容原则

- “侦探档案馆”是独立原创产品，不宣称与《名侦探柯南》官方有关联。
- 未取得授权时，不使用其角色形象、漫画插图、图鉴原文或官方视觉资产。
- 书籍与影视链接只接入出版社、正规电商、图书馆或正版视频平台。
- AI 创作优先支持原创人物和原创剧情，生成内容须经过安全审核后发布。
