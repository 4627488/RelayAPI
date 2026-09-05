# RelayAPI Web

RelayAPI 的管理控制台，基于 React、TypeScript、Vite、Tailwind CSS v4 与 shadcn/ui（Base UI）构建。

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

采用官方预设 [`b1D0eCSe`](https://ui.shadcn.com/create?preset=b1D0eCSe)：Mira、Neutral 基色/主题/图表、Hugeicons、Noto Sans、小圆角，以及 Subtle 菜单强调色和 Default 菜单色。以官方生成的组件和主题变量为准。

现有项目应用预设使用 `pnpm dlx shadcn@latest apply b1D0eCSe`；`init --preset b1D0eCSe --template vite` 用于新项目初始化。

- 组件优先使用 `src/components/ui` 中的 shadcn 原语，业务页面不要手写按钮、选择器、对话框、提示框、空状态、进度条或开关。
- 页面必须通过 `PageHeader` 提供唯一的一级标题和简短说明；区块标题从二级开始，不用大小相同的文字模拟层级。
- 颜色只使用预设提供的 `background`、`foreground`、`muted`、`primary`、`destructive` 等令牌，不额外调色。状态优先使用官方 Badge 变体和文字。
- 字体、圆角、阴影、控件高度和内边距遵循预设。业务 `className` 用于布局、响应式尺寸和数据可读性，不覆盖组件外观；不添加全局字体渲染、滚动条或表单样式。
- 表格使用官方横向滚动容器，不在基础 Table 中添加固定列接口。提示消息使用 Base UI 的 `toast.add`，复用 `components/ui/toast`。
- 状态不能只靠颜色表达；错误、成功、加载和空状态同时提供文字或图标。所有仅图标按钮必须有可读名称。
- 页面导航使用 `src/lib/routes.ts` 的地址生成与解析函数，不在组件里维护另一套页面状态，也不新增自定义 hash 路由。
- 数据页面必须覆盖首次加载、保留旧数据的刷新、可重试错误和空结果；共用 `LoadingView`、`LoadErrorView`、`Empty` 与 `InfoBar`。
- 大型页面功能通过 `React.lazy` 按路由加载。不要把图表、日志详情或管理弹窗重新打进首屏共享包。

## 路由约定

### 页面组织

- `components/app-shell.tsx` 负责工作区外壳，`lib/navigation.ts` 集中维护导航分组和显示名称。
- `components/user-workspace.tsx` 与 `components/admin-workspace.tsx` 只负责路由分发；具体页面放在 `components/user/`、`components/admin/`，按需加载。
- 模型账户的连接、管理、测试弹窗放在 `components/providers/`；共用类型和纯函数放在同目录的 `provider-helpers.ts`，弹窗不要反向引用列表页面。
- `workspace-ui.tsx` 维护页面标题、统计栏和搜索框；页面说明使用 `PageHeader.description`，优先在这里调整共用布局。
- 列表筛选要区分“尚无数据”和“筛选无结果”，后者提供清除筛选入口。手机端隐藏列时，仍需保留名称、状态和主要操作。

### 地址

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
pnpm dlx shadcn@latest add <component>
```

保持 `components.json` 中的 `base-mira`、Base UI 和 Hugeicons 配置。官方组件更新通过 CLI 比较后应用，功能组合放在业务模块，避免修改基础组件。

当前 CLI 生成的 Spinner 使用原生 SVG 属性类型，与 Hugeicons 的 `strokeWidth` 类型不兼容；本地仅将其属性类型改为 `Omit<React.ComponentProps<typeof HugeiconsIcon>, "icon">`，保留官方渲染与样式。重新应用预设后需运行类型检查，确认上游是否已修复。
