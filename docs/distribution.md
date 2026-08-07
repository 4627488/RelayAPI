# RelayAPI 分发方式

## 推荐结构

默认部署只需要一个主镜像；另发布一个按需启用的 bridge 镜像：

```text
ghcr.io/4627488/relayapi
  ├─ Go 多租户、计费和管理后端
  └─ React 管理面板与用户面板

ghcr.io/4627488/relayapi-cpa-plugin（父/子订阅必需）
  └─ CPA 凭据级调度与声明式额度 bridge

外部运行依赖
  ├─ postgres:17-alpine
  └─ eceasy/cli-proxy-api
```

CLIProxyAPI 负责协议、提供商凭据和模型路由；RelayAPI 负责用户、计费、审计与
管理界面。前端不再作为独立镜像发布，bridge 仅在启用附加 Compose 时运行一次，
把动态库复制到 CPA 插件卷中。只使用余额计费时 bridge 可省略；严格 AuthID
父/子订阅与自动额度读取统一要求 `0.6.0+`。0.6 是纯控制面插件，请求体、响应体、
终态传输错误和 TTFT 由 Relay 代理层直接采集，不经过 CPA 插件 ABI。

## GHCR 标签

CI 在 `main` 相关源码变化、发布 `v*.*.*` 标签或手动触发时，分别构建并推送
主镜像与 bridge 的 Linux AMD64/ARM64 镜像：

AMD64 与 ARM64 分别运行在 GitHub 的原生 `ubuntu-24.04` 和
`ubuntu-24.04-arm` runner 上并行构建，随后按 digest 合并为多架构 manifest；
不再在 x64 runner 上通过 QEMU 串行模拟 ARM64。

- `latest`：默认分支最新稳定构建
- `1.2.3`、`1.2`：版本标签构建
- `main`：主分支滚动构建
- `sha-xxxxxxx`：不可变提交构建

生产环境推荐固定完整版本或 SHA，不要长期跟随 `latest`。

`deploy-production.yml` 会在主镜像发布成功后，通过 GitHub `production`
environment 自动部署对应的不可变 `sha-*` 标签。生产机上的
`/opt/relayapi/deploy-relayapi.sh` 使用文件锁串行部署，更新前保存 Compose 备份，
启动后检查 `/healthz`；健康检查失败时自动恢复原镜像。也可以从 Actions 手动输入
SHA 或版本标签重新部署、升级或回滚。

## 标准安装

准备 `.env` 与 `cliproxyapi/config.yaml` 后：

```bash
docker compose pull
docker compose up -d
```

这会启动三个长期运行的容器：RelayAPI、PostgreSQL 和 CLIProxyAPI。只有 RelayAPI
对宿主机暴露 `8080`，CPA 与数据库留在私有网络。

## 本地开发

仓库中的 `build: .` 允许开发者直接使用当前源码：

```bash
docker compose up -d --build
```

也可分别运行 Go 服务和 `web/` 的 Vite 开发服务器，以获得前端热更新。

## CPA bridge

`cliproxyapi-plugin/` 提供经过签名的严格凭据调度和声明式额度
adapter 运行时。它作为独立
GHCR 镜像发布，避免把 CPA ABI 动态库塞入主镜像。启用父/子订阅时叠加：

```bash
docker compose -f docker-compose.yml -f docker-compose.plugin.yml \
  --profile plugin-install run --rm cpa-plugin
docker compose -f docker-compose.yml -f docker-compose.plugin.yml \
  up -d --no-deps --force-recreate cliproxyapi
```

插件安装是显式的一次性操作，普通 Relay 部署不得重新运行安装器。安装器先写临时
文件再原子替换动态库，替换后必须重启 CPA。随后在 CPA 配置中启用 `relayapi-bridge`，并让 `secret` 与
`CPA_PLUGIN_SECRET` 相同。仓库的 preview workflow 会在 bridge 镜像发布成功后
自动刷新插件卷并仅重启 CPA；主镜像发布成功后只重建 RelayAPI。Caddy 不属于该
发布链路。

额度 adapter 随 bridge 二进制发布，不增加第三个长期运行服务。默认 adapter 包
只是数据；自定义 provider 可直接写入 CPA 的 `plugins.configs.relayapi-bridge`
配置，无需重编译 Relay 或 bridge。生产环境可固定 bridge 的 `sha-*` 标签，并在
更新 adapter 后先手动调用父订阅额度同步接口验收。
