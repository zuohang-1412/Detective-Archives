# 侦探档案馆运行手册

## 日常检查

- 每 1 分钟探测 `/ready`；连续 3 次失败触发告警。
- 采集 `/metrics`，关注请求量、5xx 比例、P95 响应时间、进程内存和事件循环延迟。
- 每日检查容器重启次数、数据库连接数、磁盘空间和最近一次备份时间。
- 每日执行正版链接健康巡检，检查失败项和连续失败次数；巡检不会自动下架链接。
- 每周从备份中抽取一个归档，在隔离数据库完成真实恢复演练。

## 告警建议

| 告警 | 条件 | 首要动作 |
|---|---|---|
| API 不可用 | `/ready` 连续 3 分钟失败 | 检查容器日志和数据库连通性 |
| 错误率升高 | 5xx 比例连续 5 分钟超过 2% | 按路由和提交版本定位，必要时回滚 |
| 延迟升高 | P95 连续 10 分钟超过 1 秒 | 检查慢查询、连接池和主机资源 |
| 登录异常 | 登录路由非 2xx 比例突然升高 | 检查微信服务状态、AppSecret 和网络 |
| 审核积压 | 待审核内容超过运营阈值 | 通知审核人员处理，不自动公开 |
| 备份缺失 | 26 小时无成功备份 | 立即手工备份并排查定时任务 |
| 正版链接确认失效 | `last_check_ok=false` 或连续确认失败达到 3 次 | 人工打开复核，必要时在后台停用并处理读者反馈 |
| 正版链接暂无法确认 | `last_check_ok IS NULL` 且已有 `last_check_error` | 从其他网络人工打开；不因超时、反爬、429 或 5xx 自动下架 |

## 正版链接巡检

通过服务器定时任务每日执行：

```bash
npm run links:check
```

命令会校验 HTTPS、DNS 解析和每次重定向，拒绝本机、私网和保留地址，保存状态码、耗时、最终地址和失败原因。HTTP 401/403 视为“站点存在但需要权限”，不会自动判定为失效。巡检结果分为：

- `HEALTHY`：2xx/3xx 或可确认存在的 401/403。
- `BROKEN`：GET 最终明确返回 400、404 或 410；只有该状态会触发 `--fail-on-broken`。
- `UNCONFIRMED`：超时、DNS/抓取失败、429、451 或 5xx，保留为待人工复核，不累计确认失败次数。

巡检器会在 HEAD 不可用时自动回退 GET，并对暂时性错误重试。生产建议使用较低并发：

```bash
npm run links:check -- --concurrency=3 --retries=1 --timeout-ms=15000 --fail-on-broken
```

只重试上次确认失败或暂无法确认的链接：

```bash
npm run links:check -- --only-failed
```

巡检结果只作为运营线索；任何下架操作都由后台人工确认并写入审计。

仓库提供 `.github/workflows/link-health.yml` 每日任务模板。为保证数据库不暴露公网，该任务固定使用带 `detective-archives` 标签的自托管 Runner，且默认跳过。部署时需要：

1. 在生产私网安装 GitHub Actions 自托管 Runner，并添加 `detective-archives` 标签。
2. 配置仓库 Secret `DETECTIVE_ARCHIVES_DATABASE_URL`。
3. 配置变量 `DETECTIVE_ARCHIVES_PGSSLMODE=verify-full`（或记录过风险接受的实际模式）。
4. 确认 Runner 只能读取部署目录和必要数据库网络后，设置变量 `LINK_HEALTH_ENABLED=true`。

确认坏链会让任务失败并触发 GitHub Actions 通知；`UNCONFIRMED` 只写入数据库和任务日志，由后台“待人工复核”指标跟踪。禁止为了使用 GitHub 托管 Runner 而把 PostgreSQL 直接开放到公网。

## 数据库备份

服务器安装与数据库主版本兼容的 PostgreSQL 客户端后，通过定时任务每天执行：

```bash
DATABASE_URL='postgresql://...' \
BACKUP_DIRECTORY='/var/backups/detective-archives' \
BACKUP_RETENTION_DAYS=14 \
sh ops/backup-postgres.sh
```

备份目录必须加密并同步到独立存储。脚本会生成 custom-format 归档、校验目录可读性，并只清理专用目录内超过保留期的匹配文件。

校验归档：

```bash
sh ops/verify-backup.sh /var/backups/detective-archives/detective-archives-TIMESTAMP.dump
```

真实恢复必须在隔离数据库执行：先创建空库，再运行 `pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" backup.dump`，最后执行 `npm run check:db` 和 `npm run check:db-api`。禁止直接覆盖生产库进行演练。

仓库提供 `.github/workflows/database-backup.yml` 每日备份模板。它固定在生产私网的 `detective-archives` 自托管 Runner 上执行，默认关闭。启用前需要：

1. 配置 Secret `DETECTIVE_ARCHIVES_DATABASE_URL`。
2. 把变量 `DETECTIVE_ARCHIVES_BACKUP_DIRECTORY` 指向已经加密并同步到独立存储的专用绝对目录。
3. 设置 `DETECTIVE_ARCHIVES_PGSSLMODE=verify-full`（或记录过风险接受的实际模式），按需设置 `DETECTIVE_ARCHIVES_BACKUP_RETENTION_DAYS`，默认 14 天。
4. 确认 Runner 已安装与数据库主版本完全一致的 `psql`、`pg_dump`、`pg_restore` 及 `sha256sum`，再设置变量 `DATABASE_BACKUP_ENABLED=true`。脚本会拒绝客户端与服务端主版本不一致的备份，避免生成无法无错误恢复的归档。

任务会校验新归档并在日志记录 SHA-256，但日志摘要不能替代异地复制和每周恢复演练。数据库不得为了定时任务开放到公网。

## 故障处置

1. 记录开始时间、影响范围、当前提交号和请求 ID。
2. 若数据库不可用，API `/ready` 会退出负载，但 `/health` 仍可用于确认进程状态。
3. 若新版本导致错误，执行 `sh ops/rollback-release.sh`；也可显式传入上一稳定镜像标签。
4. 数据库迁移采用前向兼容新增策略；不得对生产库执行未经演练的降级 SQL。
5. 恢复后验证登录、作品详情、社区写入和后台审核，并记录根因与预防项。

## 密钥轮换

- 后台密码、监控令牌和数据库密码至少每 90 天轮换，人员变更时立即轮换。
- AppSecret 轮换后同步更新 `.env.production` 并滚动重启 API。
- `.env.production` 不进入 Git、镜像、日志或工单正文。
- 发现泄露时先撤销/轮换，再分析日志和会话影响；必要时使所有用户会话失效。
