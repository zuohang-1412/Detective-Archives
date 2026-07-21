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
4. 复制 `ops/launch-readiness.example.json` 为 `ops/launch-readiness.json`。这个文件不保存密钥，只记录真实主体、责任人和已经取得证据的外部布尔门禁；没有证据的字段保持 `false`，实际文件已被 Git 忽略。
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

回滚脚本会确认目标镜像存在，切换后重新执行就绪与运行时探测；目标镜像验证失败时会尽力恢复回滚前的应用镜像。容器自身启动时按顺序执行未应用的数据库迁移和幂等目录初始化，之后才启动 API。`/health` 表示进程存活，`/ready` 只有在数据库可用时才返回成功。

GitHub Quality 会为演练创建独立空库，并在隔离的 Compose 项目中构建两个不同镜像；启动基线镜像后实际调用 `deploy-release.sh`，核对强制备份、镜像 ID、`.release-state`，再调用 `rollback-release.sh` 并复核数据库与 HTTP，最后删除专用数据库和镜像。该演练保证脚本每次提交都可执行且不受其他集成测试数据影响，但不能替代正式服务器上的域名、TLS、监控、生产数据库网络和真实上一镜像演练。

## 4. HTTPS 与网络

- API 容器只绑定宿主机 `127.0.0.1:3000`，由 Caddy 对公网提供 443。
- 防火墙只开放 SSH、HTTP 和 HTTPS；PostgreSQL 端口仅允许数据库私网或安全组访问。
- `CORS_ORIGIN` 只能包含真实 HTTPS 来源，多个来源使用英文逗号分隔。
- 生产 PostgreSQL 优先使用 `PGSSLMODE=verify-full`；若云厂商仅提供私网非 SSL 连接，应通过安全组隔离并记录风险接受。
- 微信公众平台“开发管理 → 开发设置 → 服务器域名”中，将 API 域名加入 `request` 合法域名。

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

随后在微信开发者工具中完成：真机预览、体验版验证、代码上传、版本说明、隐私接口声明和平台审核。审核通过后选择全量发布；首次发布后保留体验版用于生产回归。

每取得一项真实证据后更新 `ops/launch-readiness.json`，并按阶段复核：

```bash
npm run launch:audit -- --env-file=.env.production --phase=post_deploy
npm run launch:audit -- --env-file=.env.production --phase=submission
npm run launch:audit -- --env-file=.env.production --phase=release
```

只有 `RELEASE` 阶段显示 `READY`，才表示生产 API、真实微信真机、平台审核和全量发布均有证据。不得为了通过门禁预先把未执行的布尔项改为 `true`。

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
