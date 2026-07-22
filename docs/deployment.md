# 侦探档案馆部署指南

## 1. 上线拓扑

首版采用单 API 容器、托管 PostgreSQL 和 Caddy HTTPS 入口。小程序只访问备案并配置到微信后台的 HTTPS API 域名；数据库不暴露到公网。

```text
微信小程序 -> HTTPS/Caddy -> Fastify API -> 托管 PostgreSQL
                                  |
                                  +-> /metrics（Bearer 凭证保护）
```

建议起步规格为 2 核 CPU、2 GB 内存、20 GB 系统盘；数据库开启自动备份和时间点恢复。API 服务至少保留最近两个可回滚镜像。

## 2. 外部资源清单

上线前由项目负责人准备：

- 已认证的微信小程序 AppID、AppSecret、运营主体和隐私联系人。
- 已备案的 API 域名及完成解析的服务器。
- 可由服务器私网访问的 PostgreSQL 连接信息。
- 长度足够的后台密码和监控令牌。
- 微信公众平台所需的隐私保护指引、用户协议和服务类目。
- 生产服务器可出站访问 `api.weixin.qq.com`，并按微信平台要求完成接口权限或 IP 白名单配置。

## 3. API 发布

1. 在服务器安装 Docker、Compose 插件、Caddy，以及与生产数据库主版本一致的 PostgreSQL 客户端。
2. 将仓库检出到仅部署用户可访问的目录。
3. 复制 `ops/production.env.example` 为根目录 `.env.production`，填写真实配置并将文件权限设为 `600`。其中 `MINIPROGRAM_APP_ID` 必须与 `WECHAT_APP_ID` 一致。
4. 复制 `ops/launch-readiness.example.json` 为 `ops/launch-readiness.json`。这个文件不保存密钥，只记录真实主体、责任人、已经取得证据的外部门禁及工具生成的摘要回执；没有证据的字段保持 `false` 或 `null`，实际文件已被 Git 忽略。
5. 将 `ops/Caddyfile.example` 复制到 Caddy 配置目录，替换真实域名并校验配置。
6. 先执行预部署审计。输出只包含缺失项、阶段和责任域，不包含任何环境变量值：

```bash
npm run launch:audit -- \
  --env-file=.env.production \
  --manifest=ops/launch-readiness.json \
  --phase=pre_deploy
```

7. 使用提交号执行受控发布：

```bash
npm ci
export IMAGE_TAG="$(git rev-parse --short HEAD)"
sh ops/deploy-release.sh "$IMAGE_TAG" .env.production ops/launch-readiness.json
```

发布脚本会依次执行预部署审计、生成生产小程序配置、完整质量与生产配置门禁、生成并校验数据库备份、构建带提交号的镜像、启动服务、等待 `/ready`，再核对数据库完整性并运行公开接口与监控探测。验证失败时，只要旧镜像仍在本机，就会自动恢复旧应用镜像；数据库迁移仍采用前向兼容策略，不执行破坏性降级。

发布成功后，当前和上一镜像标签保存在被 Git 忽略的 `.release-state/`。需要人工回滚时执行：

```bash
# 默认恢复上一个成功镜像，也可把镜像标签作为第一个参数显式传入。
API_ENV_FILE=.env.production sh ops/rollback-release.sh
```

回滚脚本会确认目标镜像存在，切换后重新执行就绪与运行时探测；目标镜像验证失败时会尽力恢复回滚前的应用镜像。容器自身启动时按顺序执行未应用的数据库迁移和目录初始化，之后才启动 API。基础种子只在数据库没有内容批次历史时写入；一旦存在 `catalog_import_batches`，重启会保留批次维护的人物字段、图鉴关联、来源和代表案件，再由批次运行器处理新增批次。`/health` 表示进程存活，`/ready` 只有在数据库可用时才返回成功。

GitHub Quality 会为演练创建独立空库，并在隔离的 Compose 项目中构建两个不同镜像；启动基线镜像后实际调用 `deploy-release.sh`，核对强制备份、镜像 ID、`.release-state`，再调用 `rollback-release.sh` 并复核数据库与 HTTP，最后删除专用数据库和镜像。该演练保证脚本每次提交都可执行且不受其他集成测试数据影响，但不能替代正式服务器上的域名、TLS、监控、生产数据库网络和真实上一镜像演练。

### 正式服务器回滚演练与回执

正式环境部署成功且本机保留上一稳定镜像后，执行一次自动化回滚演练。首次使用本能力前，候选镜像和上一镜像都必须由当前版本的 `deploy-release.sh` 构建，二者携带不同的 40 位源码提交标签；重新部署两个不同提交后再演练，不能使用标签为 `unknown` 的旧镜像。工作区除生产配置生成器允许的两个文件外必须无未提交修改，最近一次带 SHA-256 边车的部署备份不得超过 26 小时。

```bash
PRODUCTION_ROLLBACK_DRILL=true npm run release:drill:production -- \
  --env-file=.env.production \
  --manifest=ops/launch-readiness.json \
  --state-directory=/var/lib/detective-archives/release-state
```

命令会依次核对当前容器和 OCI 源码提交、从公网验证证书与 HTTP→HTTPS 跳转、探测健康/就绪/目录/社区/后台/监控，切换到上一镜像后重复探测，再恢复候选镜像并第三次探测。DNS 解析到本机、私网、保留或文档网段，证书未授权、低于 TLS 1.2、剩余有效期不足 7 天，备份过期/为空/校验失败，镜像或源码提交不一致时均会拒绝。失败时工具优先恢复候选镜像；恢复也失败时必须立即按故障处置流程人工介入。

成功回执保存在专用状态目录的 `production-release/`，并原子写入被 Git 忽略的实际 `ops/launch-readiness.json`。上线审计的 `tls_verified`、`production_release_check` 和 `rollback_drill` 三项只接受 30 天内、绑定当前 Git 提交与当前公网域名的完整回执，手工布尔值不能通过。

## 4. HTTPS 与网络

- API 容器只绑定宿主机 `127.0.0.1:3000`，由 Caddy 对公网提供 443。
- 防火墙只开放 SSH、HTTP 和 HTTPS；PostgreSQL 端口仅允许数据库私网或安全组访问。
- `CORS_ORIGIN` 只能包含真实 HTTPS 来源，多个来源使用英文逗号分隔。
- 生产 PostgreSQL 优先使用 `PGSSLMODE=verify-full`；若云厂商仅提供私网非 SSL 连接，应通过安全组隔离并记录风险接受。
- 微信公众平台“开发管理 → 开发设置 → 服务器域名”中，将 API 域名加入 `request` 合法域名。

### 外部监控和告警

生产域名部署完成后先从服务器外执行 `npm run monitor:production`，确认公网 `/ready`、受保护 `/metrics` 和默认生产阈值通过。随后按 `docs/runbook.md` 配置并手工演练 `Production Monitoring` 工作流；它每 5 分钟从 GitHub 托管 Runner 复核公网可用性，失败创建去重 Issue，恢复自动关闭。正式的 1 分钟可用性探测、Prometheus 采集和告警接收人仍由生产监控服务负责；只有两个通道都生效并完成故障/恢复演练后，才能在实际上线清单确认 `monitoringReady`。

### 加密离站备份

每日备份工作流必须在能访问数据库私网的自托管 Runner 上运行。它先生成并验证 PostgreSQL custom-format 归档，再用仓库 Secret 中独立的 32 字符以上口令和随机盐/随机 IV 执行 AES-256-GCM 流式认证加密；密文解密验证成功后删除本机明文，并将密文及 SHA-256 边车上传到 GitHub 制品存储。默认离站保留 30 天，最长范围受仓库 Actions 保留设置约束。加密口令不得与数据库、AppSecret、后台或监控凭证复用，口令代次通过非敏感 `BACKUP_KEY_ID` 标识；轮换时必须保留旧制品对应的旧密钥。正式确认 `offsiteBackupReady` 前，必须从制品页下载一份生产来源密文，按运行手册在隔离库完成解密、`pg_restore`、数据库完整性和 API 回归，并记录 RPO/RTO。

## 5. 小程序生产配置与提审

使用真实公开信息生成小程序配置：

```bash
export MINIPROGRAM_APP_ID="wx..."
export PUBLIC_API_BASE_URL="https://api.example.com"
export OPERATOR_NAME="运营主体全称"
export PRIVACY_CONTACT="privacy@example.com"
npm run config:miniprogram
npm run release:check
```

在公众平台“开发管理 → 开发设置 → 小程序代码上传”生成上传密钥并开启 IP 白名单。私钥存放在仓库外的专用发布终端或隔离 Runner，Linux 权限必须为 `600`；不要与生产数据库、AppSecret、后台密码或监控令牌放在同一份发布工具环境中。复制 `ops/miniprogram-ci.env.example` 的字段到受控环境后，先生成仓库外预览二维码：

```bash
npm run miniprogram:preview
```

用 iOS、Android 真机完成体验版主链路后，再上传同一提交的正式候选：

```bash
npm run miniprogram:upload
```

工具固定临时使用微信官方 `miniprogram-ci@2.1.31`，不把其旧构建依赖加入项目长期依赖；官方子进程仅继承网络、临时目录等最小环境，不继承数据库密码、AppSecret、后台密码、监控令牌或 `NODE_OPTIONS`。执行前会强制通过完整 `release:check`，仅允许生产配置生成器造成的两个预期文件改动。上传成功后，工具在被 Git 忽略的 `.release-state/miniprogram/` 写入 AppID、版本、源码提交、机器人编号、完成时间与配置 SHA-256 回执，并原子更新实际 `ops/launch-readiness.json`；失败不会写入成功证据。

候选上传后，将 `ops/wechat-acceptance-record.example.json` 复制到仓库外，填写真实平台配置、内容安全四路径，以及 iOS/Android 各九个主链场景的设备与证据引用，再生成绑定当前候选的验收回执：

```bash
npm run wechat:acceptance:record -- \
  --record=/secure/release/wechat-acceptance.json \
  --env-file=.env.production \
  --manifest=ops/launch-readiness.json
```

记录器不保存 AppSecret、微信 code、用户标识、测试正文或截图下载地址，只保存 AppID、候选版本、当前提交、设备版本和不含令牌的受控证据引用。平台/设备/内容安全任一场景缺失，记录超过 30 天，候选上传回执、提交或生产域名变化时，七个对应上线门禁都会拒绝。

提交平台审核前，由清单中命名的内容审核负责人和告警负责人按 `docs/runbook.md` 完成内容审核、举报结案、用户限制和紧急下架四场景演练。原始记录从 `ops/operations-drill-record.example.json` 复制到仓库外受控位置，填写后生成绑定源码和运行手册的回执：

```bash
npm run operations:drill:record -- \
  --record=/secure/release/operations-drill.json \
  --manifest=ops/launch-readiness.json
```

记录器只把负责人、场景结果、证据引用、提交号和运行手册摘要写入忽略目录及实际上线清单，不复制测试正文或密钥；缺场景、旧证据、负责人错配和运行手册变更都会阻止 `SUBMISSION` 阶段通过。

随后在公众平台完成版本说明复核、隐私接口声明和审核提交。每取得一个真实平台结果，就把 `ops/wechat-publication-event.example.json` 复制到仓库外，填写当前事件后执行：

```bash
npm run wechat:publication:record -- \
  --record=/secure/release/wechat-publication-event.json \
  --env-file=.env.production \
  --manifest=ops/launch-readiness.json
```

事件必须严格依次为 `REVIEW_SUBMITTED`、`REVIEW_APPROVED`、`PRODUCTION_RELEASED`。记录器只接受清单中命名的 `wechatPublisher`，禁止跳级、重复改写或使用带令牌/签名的证据引用；三个阶段都绑定精确上传候选、微信验收回执、当前提交、生产域名和运行手册。审核通过后选择全量发布；首次发布后保留体验版用于生产回归。`miniprogram-ci` 只完成预览和代码上传，不能替代真机、平台声明、人工提审和发布确认。参考[微信官方 miniprogram-ci 文档](https://developers.weixin.qq.com/miniprogram/dev/devtools/ci.html)。

客户端已接入 `wx.getPrivacySetting`、`wx.openPrivacyContract` 和 `agreePrivacyAuthorization`，会在微信侧存在待同步授权时先展示平台隐私指引，再进入业务登录。提审时仍需在公众平台“服务内容声明 → 用户隐私保护指引”填写与实际功能一致的处理目的；平台配置为空或声明与调用不一致时，微信会禁用相关接口或拦截提审。参考[微信官方小程序隐私协议开发指南](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html)。

发布候选固定使用稳定基础库版本，不使用开发者工具的 `trial` 模式。升级 `project.config.json` 中的 `libVersion` 前，需先在开发者工具和真机完成主链路回归；当前版本依据[微信官方基础库更新日志](https://developers.weixin.qq.com/miniprogram/dev/framework/release/)固定为 `3.17.0`。

每取得一项真实证据后更新 `ops/launch-readiness.json`，并按阶段复核。候选上传和运营演练除状态外还必须包含工具生成的绑定回执，手工只改为 `true` 不能通过：

```bash
npm run launch:audit -- --env-file=.env.production --phase=post_deploy
npm run launch:audit -- --env-file=.env.production --phase=submission
npm run launch:audit -- --env-file=.env.production --phase=release
```

只有 `RELEASE` 阶段显示 `READY`，才表示生产 API、真实微信真机、平台审核和全量发布均有证据。不得手工添加旧发布布尔项或跳过平台事件记录。

## 6. 发布验证

发布后至少验证：

- `/health`、`/ready`、公开侦探目录、作品详情与正版链接。
- 微信登录、协议确认、书架进度、短评/长评、评论、点赞和举报。
- 使用测试文本确认内容安全“通过、人工复核、明确风险、依赖故障”四条路径分别为待审、待审、拒绝、待审，且只有人工发布后公开。
- 后台登录、内容审核、举报结案、用户限制、作品及链接维护。
- 注销账号后身份不可复用、会话失效且个人内容不再公开。
- `/metrics` 无凭证返回 401，正确凭证返回 Prometheus 文本。
- `.release-state/current-image-tag` 与实际运行镜像一致，上一镜像仍可在本机读取。

完整逐项门禁见 `docs/release-checklist.md`。
