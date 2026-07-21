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
| 正版链接异常 | `last_check_ok=false` 或连续失败达到 3 次 | 人工打开复核，必要时在后台停用并处理读者反馈 |

## 正版链接巡检

通过服务器定时任务每日执行：

```bash
npm run links:check
```

命令会校验 HTTPS、DNS 解析和每次重定向，拒绝本机、私网和保留地址，保存状态码、耗时、最终地址和失败原因。HTTP 401/403 视为“站点存在但需要权限”，不会自动判定为失效。只重试上次失败的链接：

```bash
npm run links:check -- --only-failed
```

巡检结果只作为运营线索；任何下架操作都由后台人工确认并写入审计。

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

## 故障处置

1. 记录开始时间、影响范围、当前提交号和请求 ID。
2. 若数据库不可用，API `/ready` 会退出负载，但 `/health` 仍可用于确认进程状态。
3. 若新版本导致错误，使用上一提交号镜像执行 `IMAGE_TAG=<previous> docker compose up -d --no-build`。
4. 数据库迁移采用前向兼容新增策略；不得对生产库执行未经演练的降级 SQL。
5. 恢复后验证登录、作品详情、社区写入和后台审核，并记录根因与预防项。

## 密钥轮换

- 后台密码、监控令牌和数据库密码至少每 90 天轮换，人员变更时立即轮换。
- AppSecret 轮换后同步更新 `.env.production` 并滚动重启 API。
- `.env.production` 不进入 Git、镜像、日志或工单正文。
- 发现泄露时先撤销/轮换，再分析日志和会话影响；必要时使所有用户会话失效。
