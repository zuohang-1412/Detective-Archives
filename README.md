# 侦探档案馆

一个面向推理爱好者的侦探作品图鉴、阅读记录与交流社区。产品采用原创品牌定位，以公开书目信息和正版外链连接读者与经典推理作品。

## 当前版本

`v0.1.0` 是 MVP 发布候选版本，已经包含：

- 原生微信小程序：首页、档案搜索、侦探详情、作品详情与正版渠道。
- TypeScript API：健康检查、数据库仓储、侦探/图鉴/扩展目录/作品查询。
- 132 位正式目录人物及 125 部可浏览代表作品数据，109 条图鉴记录均已关联正式档案；73 条已提取原始推荐标签全部可进入对应作品、合集或系列的正版渠道。
- 第 1～108 卷名侦探图鉴索引，共 109 条记录（含第 105 卷特装版）。
- 20 位图鉴之外的知名虚构侦探，以及 3 位独立展示的历史断案人物。
- PostgreSQL 运行时连接、增量迁移、目录初始化、作品与正版链接仓储和完整性检查。
- 微信 `code2Session` 服务端身份、单次轮换会话令牌、退出登录和个人书架进度。
- 短评/长评、本人编辑删除、剧透折叠、回复、点赞、举报、内容申诉、微信内容安全预检和默认人工待审核流程。
- 内置运营后台：独立管理员登录、产品指标、侦探/来源/代表案件/作品维护、评价审核、举报与申诉处理、角色管理、审计日志和链接质量反馈；所有列表按每页最多 50 条读取并完整加载。
- 登录前协议/隐私确认、微信平台隐私状态查询与授权同步、同意时间留存、个人数据 JSON 导出，以及撤销身份、会话和个人内容的账号注销流程；账号受限期间仍可导出、退出和注销，开发工具固定使用明确的稳定基础库版本。
- 隐私最小化的档案/作品访问转化、正版点击、首加书架、完成后评价、7/30 日留存、评论举报、审核时长和申诉恢复率，以及安全响应头、限流、生产配置硬校验、运维指标和优雅停机。
- Docker/Caddy 部署基线、CI 质量门禁、数据库备份脚本、小程序候选预览/上传入口与上线运行手册。
- 产品 PRD、页面规划和技术架构文档。
- API 自动化测试。

首版目录已形成 132 位人物、125 部作品、126 条正版/馆藏链接和 73 条图鉴推荐直达的数据闭环；已发布人物均有权威来源确认，内容仍会持续核验与扩充。AI 视频属于 P2 范围，详见 `docs/PRD-v0.1.md`。

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
- `POST /api/v1/auth/refresh`
- `GET /api/v1/auth/me`
- `POST /api/v1/auth/logout`
- `GET /api/v1/me/data-export`
- `DELETE /api/v1/me/account`
- `GET /api/v1/me/shelf`
- `PUT /api/v1/me/shelf/:workId`
- `DELETE /api/v1/me/shelf/:workId`
- `GET|POST /api/v1/works/:workId/reviews`
- `GET|PATCH|DELETE /api/v1/reviews/:reviewId`
- `POST /api/v1/reviews/:reviewId/comments`
- `PUT|DELETE /api/v1/reviews/:reviewId/like`
- `PUT|DELETE /api/v1/comments/:commentId/like`
- `POST /api/v1/reports`
- `POST /api/v1/work-links/:linkId/click`
- `POST /api/v1/work-links/:linkId/feedback`
- `POST /api/v1/auth/admin`
- `GET /api/v1/admin/dashboard`
- `GET /api/v1/admin/moderation`
- `POST /api/v1/admin/moderation/:targetType/:targetId`
- `PATCH /api/v1/admin/reports/:reportId`
- `GET|POST /api/v1/admin/works`
- `POST /api/v1/admin/works/:workId/links`
- `GET|POST|PATCH /api/v1/admin/detectives`
- `GET|PATCH /api/v1/admin/users`
- `GET /api/v1/admin/audit-logs`
- `GET|PATCH /api/v1/admin/work-link-feedback`

### 4. 打开小程序

使用微信开发者工具导入仓库根目录。开发阶段使用游客 AppID，接口地址由 `apps/miniprogram/app.js` 中的 `apiBaseUrl` 控制。

接入真实小程序前，需要替换 `project.config.json` 中的 AppID，并为生产环境配置合法的 HTTPS API 域名。
同时需要在 `apps/miniprogram/config.js` 中填写真实运营主体和隐私联系渠道；生产预检会拒绝这些字段保留占位文本。

生产配置可通过环境变量一次写入（均为公开发布信息，不包含 AppSecret）：

```bash
MINIPROGRAM_APP_ID=wx... \
PUBLIC_API_BASE_URL=https://api.example.com \
OPERATOR_NAME=运营主体全称 \
PRIVACY_CONTACT=privacy@example.com \
npm run config:miniprogram
```

正式候选使用微信官方 `miniprogram-ci` 的固定版本执行。代码上传私钥必须保存在仓库外并开启公众平台 IP 白名单；预览二维码同样写到仓库外。配置示例见 `ops/miniprogram-ci.env.example`：

```bash
npm run miniprogram:preview
npm run miniprogram:upload
```

两个命令都会先执行完整 `release:check`，拒绝游客 AppID、HTTP 域名、占位主体、仓库内私钥、非预期工作区改动和重复覆盖二维码。上传成功后才生成 `.release-state/miniprogram/` 回执，并把实际 `ops/launch-readiness.json` 的候选上传门禁更新为带提交号的成功证据；示例清单不会被改写。

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

生产环境变量和小程序发布信息就绪后，执行完整上线预检：

```bash
npm run launch:audit -- --env-file=.env.production --manifest=ops/launch-readiness.json --phase=pre_deploy
npm run release:check
```

`launch:audit` 只报告门禁状态和责任域，不输出数据库密码、AppSecret、后台密码或监控令牌。它按 `PRE_DEPLOY`、`POST_DEPLOY`、`SUBMISSION`、`RELEASE` 四阶段核验，实际清单从 `ops/launch-readiness.example.json` 复制后填写，且已被 Git 忽略。部署、备份、监控、回滚和小程序提审步骤见 `docs/deployment.md` 与 `docs/runbook.md`。生产服务器可通过 `ops/deploy-release.sh` 完成预部署审计、小程序配置生成、发布前备份、带提交号构建、运行时探测和失败自动回滚，并通过 `ops/rollback-release.sh` 恢复上一稳定镜像。GitHub Quality 还会在独立空库中使用两个不同镜像 ID 实际执行这两个脚本，核对备份、当前/上一镜像状态与回滚后的数据库和 HTTP 探测；正式服务器仍需按同一流程留下生产演练证据。

基础目录种子只负责没有内容批次历史的新数据库。检测到 `catalog_import_batches` 后，重复启动会保留批次维护的人物字段、图鉴关联、来源与代表案件；正式内容变更必须继续通过新的不可变批次完成，不能依赖重跑基础种子覆盖线上数据。

图鉴与扩展目录数据的来源、编号和核验状态见 `docs/data-sources.md`。如需从公开索引重新生成 1～100 卷事实字段，可执行：

```bash
npm run catalog:sync
```

正式目录扩充采用“清单驱动、预检后导入”。命令会按清单依次检查或事务化应用全部不可变批次；已经应用的批次通过文件校验和保证不可静默改写：

```bash
npm run catalog:preflight
npm run catalog:apply
```

若最新批次发现内容错误，必须新建不可变补偿批次，在根级填写 `rollbackOf`、`rollbackReason`，并通过 `archiveDetectiveSlugs` / `archiveWorkSlugs` 归档新增内容，或在 `detectives` 中恢复旧状态。补偿批次必须放在清单末尾，并使用显式命令；工具拒绝回滚非最新批次，归档作品会同步停用链接但保留书架、评价和审计引用：

```bash
npm run catalog:rollback:preflight -- --file=apps/api/src/data/catalog-expansion-rollback-001.json
npm run catalog:rollback:apply -- --file=apps/api/src/data/catalog-expansion-rollback-001.json
```

定时巡检启用中的正版链接，并仅重试上轮失败项：

```bash
npm run links:check
npm run links:check -- --only-failed
```

## 品牌与内容原则

- “侦探档案馆”是独立原创产品，不宣称与《名侦探柯南》官方有关联。
- 未取得授权时，不使用其角色形象、漫画插图、图鉴原文或官方视觉资产。
- 书籍与影视链接只接入出版社、正规电商、图书馆或正版视频平台。
- AI 创作优先支持原创人物和原创剧情，生成内容须经过安全审核后发布。
