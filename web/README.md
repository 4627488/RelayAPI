# RelayAPI Web

RelayAPI 的管理控制台，基于 React、TypeScript、Vite、Tailwind CSS v4 与 shadcn/ui **Nova**（Base UI，黑白 Neutral）构建。视觉合同见仓库根目录 `DESIGN.md`。

## 本地开发

```bash
pnpm install
pnpm dev
```

提交前运行完整前端门禁：

```bash
pnpm check
```

它会依次检查格式、类型、代码规范、真实 Chromium 中的组件与无障碍测试，以及生产构建。

## 界面规范

- 组件优先使用 `src/components/ui` 中的 shadcn 原语，业务页面不要手写按钮、选择器、对话框、提示框、空状态、进度条或开关。
- 页面必须通过 `PageHeader` 提供唯一的一级标题和简短说明；区块标题从二级开始，不用大小相同的文字模拟层级。
- 颜色只使用 `background`、`foreground`、`muted`、`primary`、`positive`、`warning`、`info`、`destructive` 等语义令牌。业务组件不得直接写 `emerald-*`、`amber-*` 等具体色阶。
- 正文用 Geist，中文回退系统黑体；模型名、请求 ID、金额明细和代码用 JetBrains Mono。圆角跟 Nova（约 10px），头像、开关和进度轨道可以全圆角。
- 状态不能只靠颜色表达；错误、成功、加载和空状态同时提供文字或图标。所有仅图标按钮必须有可读名称。
- 页面导航使用 `src/lib/routes.ts` 的地址生成与解析函数，不在组件里维护另一套页面状态，也不新增自定义 hash 路由。
- 数据页面必须覆盖首次加载、保留旧数据的刷新、可重试错误和空结果；共用 `LoadingView`、`LoadErrorView`、`Empty` 与 `InfoBar`。
- 大型页面功能通过 `React.lazy` 按路由加载。不要把图表、日志详情或管理弹窗重新打进首屏共享包。

## 路由约定

- 用户工作台：`/app`、`/app/usage`、`/app/keys`、`/app/logs/:id`
- 管理工作台：`/admin`、`/admin/users/invitations`、`/admin/settings/proxies`、`/admin/logs/:id`
- 日志 ID 必须通过 `routeHref` 编码；旧的 `#log=` 地址只用于兼容迁移。

## 测试约定

- 浏览器测试文件命名为 `*.browser.test.tsx`。
- 共享组件至少验证可访问名称、键盘操作和 axe WCAG 规则。
- 路由变更至少验证可刷新恢复、包含特殊字符的日志 ID，以及未知地址的安全回退。
- 测试失败产生的截图和 trace 位于忽略目录中，不提交到仓库。

## 添加组件

先确认项目中没有等价原语，再通过 shadcn CLI 添加：

```bash
pnpm exec shadcn@latest add <component>
```

保持 `components.json` 中的 `base-nova`、Base UI、Lucide 和官方 Neutral 黑白主题。不要手调成蓝灰或再引入另一套图标库。
