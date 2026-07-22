# 侦探档案馆运行手册

## 上线证据审计

非敏感上线事实保存在部署机的 `ops/launch-readiness.json`，密钥继续只放在权限为 `600` 的 `.env.production`。执行：

```bash
npm run launch:audit -- --env-file=.env.production --phase=release
```

审计器会按预部署、部署后、提审和正式发布四阶段列出阻塞项及责任域，不打印输入值。运营人员只能在取得可复查证据后更新布尔项，例如 TLS 探测结果、回滚记录、真机测试记录或微信审核结果；每次变更应在发布工单中记录时间和证据位置。

### 生产发布回滚证据

部署机必须保留两个由新版部署脚本构建、来自不同 Git 提交且可读取 OCI 源码标签的镜像。确认最近 26 小时的生产备份及 `.sha256` 边车可读后执行：

```bash
PRODUCTION_ROLLBACK_DRILL=true npm run release:drill:production -- \
  --env-file=.env.production \
  --manifest=ops/launch-readiness.json \
  --state-directory=/var/lib/detective-archives/release-state
```

演练会真实执行“候选版→上一版→候选版”，每次切换后从公网验证 HTTPS、证书、跳转、核心 API、社区、运营后台和鉴权监控。若命令报告候选版恢复失败，立即停止发布并按“故障处置”人工恢复；不要再次盲目切换。成功后再次执行 `launch:audit --phase=post_deploy`，三个生产发布门禁应同时为 `READY`。回执绑定当前提交、域名、镜像 ID、备份摘要和三次探测，不得手工复制、修改或用布尔值替代。

## 运营上岗演练

微信提审前，清单中的实际内容审核负责人和生产告警负责人必须在受控候选环境完成四个场景。只使用明确标注的测试账号、测试作品和测试评价；不得拿真实用户内容做演练，也不得把令牌、密码、用户个人信息或违规正文复制到证据记录。

1. **内容审核**：测试用户分别提交可发布和应拒绝的评价；审核负责人填写理由后执行发布、拒绝和隐藏，核对作者状态、游客可见性、`moderation_records` 与 `audit_logs`。
2. **举报结案**：两个测试请求对同一内容重复举报，确认只产生一个开放举报；审核负责人完成受理和结案，核对第二次结案失败且内部备注不向举报人公开。
3. **用户限制**：限制测试普通用户，确认书架、评价和链接反馈等普通写入为 403，同时账号状态、个人数据导出、退出和注销仍可用；不得限制当前操作员本人。
4. **紧急下架**：准备一部已发布测试作品、已发布评价和启用链接，依次隐藏评价、下架作品并停用链接；核对目录、社区、评价详情和已知旧链接立即不可公开访问，私人书架仅保留不可用占位，最后按审批记录恢复或清理测试数据。

每个场景都要在发布工单或受控证据目录中保留时间、操作员、测试资源 ID、请求 ID、预期、实际结果和必要截图；证据引用不得包含访问令牌或带签名下载地址。把模板复制到仓库外并填写真实负责人、90 天内的规范 UTC ISO-8601 完成时间和四个场景的独立证据引用：

```bash
cp ops/operations-drill-record.example.json /secure/release/operations-drill.json
npm run operations:drill:record -- \
  --record=/secure/release/operations-drill.json \
  --manifest=ops/launch-readiness.json
```

记录器要求绝对路径和已提交源码；只允许生产配置生成器造成的 `project.config.json` 与 `apps/miniprogram/config.js` 两项预期修改。它还会拒绝仓库内输入、占位负责人、负责人不匹配、缺场景、失败场景、超出 5 分钟容差的未来时间和超过 90 天的旧证据。成功后在 `.release-state/operations-drill/` 保存权限收紧、绑定当前源码提交和本运行手册 SHA-256 的回执，并原子写入实际 `ops/launch-readiness.json`；原始演练记录仍留在仓库外。再次执行提审审计，`operations_drill` 必须为 `READY`：

```bash
npm run launch:audit -- --env-file=.env.production --phase=submission
```

运行手册变更会使旧回执失效，负责人变更或回执超过 90 天也必须重新演练。不得手工伪造回执或仅修改布尔值。

## 小程序候选证据

- 上传密钥保存在仓库外，仅授予专用发布终端或隔离 Runner；公众平台开启代码上传 IP 白名单，人员变更或疑似泄露时立即重置。
- `npm run miniprogram:preview` 的二维码按敏感临时文件管理，真机验收完成后删除；命令拒绝覆盖已有二维码。
- `npm run miniprogram:upload` 只在全量发布门禁、生产配置和工作区边界通过后调用官方上传工具。第三方工具子进程不会继承数据库、微信 AppSecret、后台或监控凭证。
- 成功回执位于 `.release-state/miniprogram/`，包含 AppID、候选版本、40 位源码提交、机器人编号、时间和配置摘要；上传命令会同步更新实际上线清单。公众平台版本列表与回执一致后，才能把候选交给人工提审。
- 失败、超时或本地回执写入异常时，不得手工伪造 `candidateUploadReceipt`；先到公众平台确认是否已经产生候选，再决定重试或补录事件。

### 微信候选验收回执

候选上传成功后，把 `ops/wechat-acceptance-record.example.json` 复制到仓库外受控证据目录。实际验收负责人填写候选 AppID/版本/生产 API Origin、完成时间和证据引用；不得填写微信 code、OpenID、用户数据、测试正文、密码、令牌、带签名下载地址或风险文本原文。

平台配置必须覆盖服务类目、隐私保护指引、用户协议和 `request` 合法域名；内容安全必须覆盖安全文本通过、需复核文本待审、风险文本拒绝、依赖故障保持待审四条路径；iOS 和 Android 各自必须覆盖隐私拒绝/同意、登录、目录搜索筛选、书架进度、评价社区、举报、个人数据导出/文件分享和注销九个场景。两个设备运行应在整体验收完成前 7 天内，整份回执有效期为 30 天。

```bash
cp ops/wechat-acceptance-record.example.json /secure/release/wechat-acceptance.json
# 在仓库外填写真实结果后执行
npm run wechat:acceptance:record -- \
  --record=/secure/release/wechat-acceptance.json \
  --env-file=.env.production \
  --manifest=ops/launch-readiness.json
npm run launch:audit -- --env-file=.env.production --phase=submission
```

记录器要求已提交源码，只允许生产配置生成器造成的两个预期文件修改；执行人必须与上线清单中预先命名的 `wechatTester` 一致，真实 AppID、当前提交和实际候选上传回执也必须一致。成功回执写入 `.release-state/wechat-acceptance/` 并原子更新实际上线清单。候选版本、源码提交、配置摘要、公网域名、验收负责人或本运行手册变化后必须重新验收；不得手工恢复旧的七个布尔字段。

真机验收通过后，由清单中的 `wechatPublisher` 在公众平台每完成一步就登记一次发布事件：

```bash
cp ops/wechat-publication-event.example.json /secure/release/wechat-publication-event.json
# 依次填写 REVIEW_SUBMITTED、REVIEW_APPROVED、PRODUCTION_RELEASED
npm run wechat:publication:record -- \
  --record=/secure/release/wechat-publication-event.json \
  --env-file=.env.production \
  --manifest=ops/launch-readiness.json
npm run launch:audit -- --env-file=.env.production --phase=release
```

每个事件的原始记录留在仓库外，受控证据引用不得含访问令牌、签名参数或 URL 凭证。记录器从实际上线清单读取前一状态，拒绝跳级、改写和候选错配；相同事件原样重放保持幂等。新候选上传后必须重新完成微信验收和三个发布事件，旧回执不得沿用。

## 日常检查

- 每 1 分钟探测 `/ready`；连续 3 次失败触发告警。
- 采集 `/metrics`，关注请求量、5xx 比例、P95 响应时间、进程内存和事件循环延迟。
- GitHub 外部安全网每 5 分钟复核一次公网可用性和指标阈值；它用于发现监控盲区，不替代上述 1 分钟生产探测。
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
| 正版链接暂无法确认 | `last_check_ok IS NULL` 且已有 `last_check_error` | 按底层 TLS/DNS/超时错误从其他网络人工打开；不自动下架 |

## 生产外部监控

仓库提供 `.github/workflows/production-monitoring.yml`。它固定使用 GitHub 托管 Runner，从生产网络之外检查精确 HTTPS 域名，且默认关闭。启用前配置：

1. 仓库变量 `PUBLIC_API_BASE_URL=https://实际 API 域名`。
2. 仓库 Secret `PRODUCTION_METRICS_AUTH_TOKEN`，值与生产 `METRICS_AUTH_TOKEN` 一致；不得复用 AppSecret、数据库或后台密码。
3. 可选仓库变量 `MONITOR_MAX_5XX_RATIO`（默认 `0.02`）、`MONITOR_MAX_P95_SECONDS`（默认 `1`）、`MONITOR_MAX_RSS_BYTES`（默认 `805306368`）、`MONITOR_MAX_EVENT_LOOP_LAG_SECONDS`（默认 `0.25`）和 `MONITOR_SAMPLE_INTERVAL_MS`（默认 `15000`）。
4. 先从 Actions 手工运行 `Production Monitoring`，确认 `/ready`、无令牌访问 `/metrics` 返回 401、带令牌指标与所有阈值通过。
5. 临时填写错误的公开域名并手工运行一次，确认只创建一个带 `production-monitoring` 标签的告警 Issue；恢复正确域名后再次运行，确认自动留言并关闭。演练期间不要修改生产令牌，也不要把令牌写入 Issue。
6. 命名实际告警接收人并确认其订阅仓库 Issue 后，设置 `PRODUCTION_MONITORING_ENABLED=true`；只有手工成功、故障开单和恢复闭环都完成后，才能把实际上线清单的 `monitoringReady` 设为 `true`。

本地或受控终端可用同一探测器复核，输出只含公开域名、阈值结果与时间，不含监控令牌：

```bash
PUBLIC_API_BASE_URL=https://api.example.cn \
METRICS_AUTH_TOKEN='独立监控令牌' \
npm run monitor:production
```

GitHub 定时任务的最短间隔为 5 分钟，且可能因平台负载延迟，因此生产环境仍需另行配置 1 分钟外部 `/ready` 探测；GitHub 任务作为独立告警通道和公网回归安全网。

## 正版链接巡检

通过服务器定时任务每日执行：

```bash
npm run links:check
```

命令会校验 HTTPS、DNS 解析和每次重定向，拒绝本机、私网和保留地址，保存状态码、耗时、最终地址和失败原因。HTTP 401/403 视为“站点存在但需要权限”，不会自动判定为失效。巡检结果分为：

- `HEALTHY`：2xx/3xx 或可确认存在的 401/403。
- `BROKEN`：GET 最终明确返回 400、404 或 410；只有该状态会触发 `--fail-on-broken`。
- `UNCONFIRMED`：超时、TLS、DNS/抓取失败、429、451 或 5xx，保留底层错误码并进入人工复核，不累计确认失败次数。

巡检器会在 HEAD 不可用时自动回退 GET，并对暂时性错误重试。生产建议使用较低并发：

```bash
npm run links:check -- --concurrency=3 --retries=1 --timeout-ms=15000 --fail-on-broken
```

只重试上次确认失败或暂无法确认的链接：

```bash
npm run links:check -- --only-failed
```

运营人员在后台“正版链接人工复核”按以下顺序处理：

1. 打开正版入口，核对作品、渠道、地区和最终落地页；自动确认 400/404/410 的项目优先处理，不能登记为有效，应停用或替换为新的正版入口。
2. 填写至少 5 个字的判断说明，以及出版社页面、工单号或受控截图编号。禁止粘贴带访问令牌、签名、密钥或密码的地址。
3. “人工确认有效”只关闭不确定或超期队列 90 天，不覆盖后续自动确认失效；两路重复提交只产生一次审计。
4. “确认失效并停用”在同一事务保存证据并停止公开。需要恢复时先由管理员重新启用；旧自动/人工健康证据会清空，链接重新等待巡检。
5. 复核完成后在审计日志确认 `WORK_LINK_MANUAL_VERIFIED` 或 `WORK_LINK_MANUAL_REJECTED` 的操作者、资源和证据引用完整。

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

基础脚本会生成 custom-format 归档、校验目录可读性，并只清理专用目录内超过保留期的明文、密文及对应 SHA-256 边车。手工执行基础脚本时会保留明文，必须放在加密磁盘；每日工作流会在验证密文可解密后自动删除本次明文。

校验归档：

```bash
sh ops/verify-backup.sh /var/backups/detective-archives/detective-archives-TIMESTAMP.dump
```

从离站存储下载密文和同名 `.sha256` 后，在仓库外的受控临时目录执行：

```bash
read -r -s -p '输入对应 BACKUP_KEY_ID 的恢复密钥：' BACKUP_ENCRYPTION_PASSPHRASE
export BACKUP_ENCRYPTION_PASSPHRASE
printf '\n'
npm run backup:verify-encrypted -- /secure/restore/detective-archives-TIMESTAMP.dump.enc
npm run backup:decrypt -- \
  /secure/restore/detective-archives-TIMESTAMP.dump.enc \
  /secure/restore/decrypted-TIMESTAMP.dump
sh ops/verify-backup.sh /secure/restore/decrypted-TIMESTAMP.dump
unset BACKUP_ENCRYPTION_PASSPHRASE
```

工具拒绝相对路径、符号链接输入、空文件、错误密钥、缺少或不匹配的 SHA-256、篡改密文及任何已有输出覆盖；口令不进入日志或制品。解密完成后再创建隔离空库，运行 `pg_restore --clean --if-exists --no-owner --dbname="$RESTORE_DATABASE_URL" decrypted-TIMESTAMP.dump`，最后执行 `npm run check:db` 和 `npm run check:db-api`。禁止直接覆盖生产库进行演练；完成后安全删除临时明文。

## 内容批次回滚

内容批次导入在单一事务内执行；事务失败不会留下部分数据。清单运行器对连接重置、超时、DNS 临时失败和数据库重启等明确的瞬时故障默认重试 2 次，校验、约束或 SQL 错误立即失败；可用 `--transient-retries=0` 关闭重试，允许范围为 0～5。若已应用的最新批次需要撤销，禁止改写原 JSON 或直接删除数据库记录：

1. 先确认上线前整库备份可读，并暂停新的目录导入。
2. 新建补偿批次，`rollbackOf` 必须指向当前最新 `APPLIED` 批次，填写 `rollbackReason`。
3. 用 `detectives` 恢复被覆盖的旧值；用 `archiveDetectiveSlugs`、`archiveWorkSlugs` 归档新增内容。归档不会删除用户关系，作品链接会自动停用。
4. 执行 `npm run catalog:rollback:preflight -- --file=补偿文件`，复核差异、来源和归档范围。
5. 将补偿文件加入清单末尾，再执行 `npm run catalog:rollback:apply -- --file=补偿文件`。
6. 运行 `npm run check:db`、`npm run check:db-api`，确认原批次为 `ROLLED_BACK`、补偿批次为 `APPLIED` 并记录处置结果。

工具会拒绝非最新批次、缺少原因、同批次同时恢复和归档同一人物、未知归档对象及校验和变化。若后续批次已经应用，应新建新的前向纠错批次，不得跨批次逆序回滚。

仓库提供 `.github/workflows/database-backup.yml` 每日备份模板。它固定在生产私网的 `detective-archives` 自托管 Runner 上执行，默认关闭；手工触发不要求先启用定时开关。启用前需要：

1. 在 GitHub 创建 `production-backup` Environment，只允许默认分支使用；每日任务不能设置人工审批等待。以下 Secret 和变量优先配置在该 Environment，并保护默认分支，避免未审核工作流读取备份凭证。
2. 配置 Secret `DETECTIVE_ARCHIVES_DATABASE_URL`。
3. 配置仅用于备份的 Secret `DETECTIVE_ARCHIVES_BACKUP_PASSPHRASE`，至少 32 个随机字符；把恢复副本保存在仓库和 Runner 之外的密码管理器，禁止复用其他凭证。
4. 把变量 `DETECTIVE_ARCHIVES_BACKUP_DIRECTORY` 指向专用绝对目录；设置 `DETECTIVE_ARCHIVES_BACKUP_KEY_ID`（默认 `primary`，只含字母数字、点、下划线或连字符），用于标记制品对应的密钥代次。
5. 设置 `DETECTIVE_ARCHIVES_PGSSLMODE=verify-full`（或记录过风险接受的实际模式），按需设置本机 `DETECTIVE_ARCHIVES_BACKUP_RETENTION_DAYS`（默认 14 天）和离站 `DETECTIVE_ARCHIVES_OFFSITE_RETENTION_DAYS`（默认 30 天，GitHub 通常最多 90 天或以仓库设置为准）。
6. 确认 Runner 已安装 Node.js 24，以及与数据库主版本完全一致的 `psql`、`pg_dump`、`pg_restore` 和 `sha256sum`。先手工运行一次 `Database Backup`，确认日志不含口令、本机只留下 `.dump.enc`/`.sha256`、制品页可下载两个文件。
7. 从制品页下载刚生成的密文，按上面的步骤完成真实隔离恢复并记录开始时间、恢复完成时间、数据时间点、RPO、RTO 和负责人；成功后设置变量 `DATABASE_BACKUP_ENABLED=true`，再把实际上线清单的 `offsiteBackupReady` 设为 `true`。

任务使用随机盐、随机 IV、scrypt 派生密钥和 AES-256-GCM 认证密文；同一明文重复加密也不会得到相同输出。GitHub 制品是与生产主机分离的首层离站副本，但不能代替长期对象锁或多云灾备；每周仍需抽取制品恢复，重要运营期应另行复制到受控对象存储。数据库不得为了定时任务开放到公网。轮换密钥时先修改 `BACKUP_KEY_ID` 并保存旧密钥，旧制品过期后才能销毁旧密钥。

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
