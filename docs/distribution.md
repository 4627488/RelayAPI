# RelayAPI 分发方式

## 推荐结构

默认部署只需要 RelayAPI 和 PostgreSQL：

```text
ghcr.io/4627488/relayapi
  ├─ Go 多租户、计费和管理后端
  ├─ 内嵌 CPA 推理运行时
  └─ React 管理面板与用户面板

postgres:17-alpine
```

不再发布或部署外置 CLIProxyAPI 数据面、CPA bridge 镜像和 C-ABI 插件。
RelayAPI 的公开入口负责鉴权、准入与计费，进程内 CPA 负责协议、提供商凭据、
模型路由和 WebSocket 会话；上游额度也由 RelayAPI 内嵌适配器定时观测。

## GHCR 标签

CI 在 `main` 相关源码变化、发布 `v*.*.*` 标签或手动触发时构建 Linux
AMD64/ARM64 主镜像：

- `latest`：默认分支最新稳定构建
- `1.2.3`、`1.2`：版本标签构建
- `main`：主分支滚动构建
- `sha-xxxxxxx`：不可变提交构建

生产环境推荐固定完整版本或 SHA。`deploy-production.yml` 在主镜像发布成功后
部署对应的不可变 `sha-*` 标签，并通过 `/healthz` 验证内嵌运行时；失败时恢复
原镜像。

## 标准安装

准备 `.env` 后运行：

```bash
docker compose pull
docker compose up -d
```

这会启动 RelayAPI 与 PostgreSQL 两个长期运行的容器，只有 RelayAPI 对宿主机
暴露 `8080`。

## 本地开发

```bash
docker compose up -d --build
```

也可分别运行 Go 服务和 `web/` 的 Vite 开发服务器，以获得前端热更新。
