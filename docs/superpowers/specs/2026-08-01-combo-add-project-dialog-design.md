# combo 设计:添加项目改为目录选择对话框

日期:2026-08-01
状态:已评审(经 brainstorming 流程,用户确认)

## 1. 目标

点击「添加项目」不再填写项目路径,而是弹出目录选择对话框,由用户直接选择
项目目录。

- **Tauri 桌面模式**:使用官方 `tauri-plugin-dialog` 弹出原生目录选择框,
  选中的绝对路径直接用于创建工作区。
- **浏览器模式(开发/e2e)**:浏览器安全限制导致无法从目录选择器获得绝对
  路径(`<input webkitdirectory>` 只给相对路径),因此彻底移除路径输入框,
  点「添加项目」时提示「请在桌面版中选择项目目录」。

## 2. 方案对比

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 官方 `tauri-plugin-dialog` | JS 包已在 `package.json`;Rust 侧注册插件 + capability 权限即可 | **采用** |
| B. 自写 Rust command + `rfd` | 同样弹原生对话框,但多维护一份自定义命令 | 否 |
| C. `<input webkitdirectory>` | 浏览器模式拿不到绝对路径,功能不可用 | 否 |

## 3. 功能设计

### 3.1 `src-tauri`(桌面壳)

- `src-tauri/Cargo.toml` 增加依赖 `tauri-plugin-dialog = "2"`。
- `src-tauri/src/lib.rs` 在 `tauri::Builder::default()` 链上注册
  `.plugin(tauri_plugin_dialog::init())`。
- `src-tauri/capabilities/default.json` 的 `permissions` 增加
  `"dialog:allow-open"`(仅授予打开对话框权限,不授予保存对话框)。

### 3.2 `WorkspaceSidebar.tsx`(前端)

- 删除 `<Input placeholder="输入项目路径">` 与 `path` state;「添加项目」
  按钮不再因空路径 `disabled`。
- 点击「添加项目」:
  1. 若 `isTauri()`(`src/lib/connection.ts` 已有检测):动态
     `import('@tauri-apps/plugin-dialog')`,调用
     `open({ directory: true, multiple: false })`。返回非空字符串则
     `await create(path)`;返回 `null`(用户取消)则无操作。出错时把
     `e.message` 显示到现有的 `fileError` 提示区。
  2. 否则(浏览器模式):`setFileError('请在桌面版中选择项目目录')`。
- 对话框打开期间按钮进入 loading 态并 `disabled`,防止重复点击。
- 空状态文案由「还没有项目。输入项目路径添加一个,然后从文件树打开文件。」
  改为「还没有项目。点击『添加项目』选择项目目录,然后从文件树打开文件。」

### 3.3 测试与文档

- `src/components/shell/WorkspaceSidebar.test.tsx`:
  - 第二条用例改为:mock `@tauri-apps/plugin-dialog` 的 `open` 返回
    `/proj/c`,点击「添加项目」后断言列表出现 `/proj/c`(即 `create`
    被以该路径调用)。
  - 新增用例:非 Tauri 环境(默认 jsdom 即非 Tauri)点击按钮,断言出现
    提示文案。
  - mock `isTauri`(从 `src/lib/connection.ts` import)以便两种环境分别
    覆盖。
- `e2e/vertical-slice.spec.ts`:浏览器模式无法通过 UI 添加项目,改为在
  进入页面后通过 API 前置创建工作区:`page.evaluate` 内 `fetch
  POST /v1/workspaces`(query 与 body 均带 `client_id`,`body` 为
  `{ path: tmp, client_id }`),保持后续「激活工作区 → 新建会话 → 发送任务」
  链路不变。`client_id` 取 `localStorage['combo.clientId']`,若页面尚未生成
  则先按 `src/lib/clientId.ts` 的生成逻辑(优先 `crypto.randomUUID`,回退
  手工 UUID 模板)写入后再用,保证与 `apiRequest` 的注入值一致。
- `AGENTS.md`:更新 e2e 选择器说明,移除 `getByPlaceholder('输入项目路径')`
  引用,补充「添加项目」改为目录对话框的说明。

## 4. 数据流

```
Tauri 模式:
  点击「添加项目」 → plugin-dialog open({directory:true}) → 绝对路径
    → createWorkspace(path) → POST /v1/workspaces → rune → 项目列表刷新

浏览器模式:
  点击「添加项目」 → 提示「请在桌面版中选择项目目录」
```

## 5. 错误处理

- 用户取消对话框:静默无操作。
- 对话框/创建工作区抛错:显示在侧边栏底部 `fileError` 区(沿用现有样式)。
- 浏览器模式点击:直接提示桌面版可用,不发起任何请求。

## 6. 测试计划

- 单元(Vitest + Testing Library):组件用例覆盖「Tauri 模式选择目录创建」、
  「浏览器模式提示」两条路径。
- Rust:`combo-proxy` 无改动,无需新增 Rust 测试;`src-tauri` 改动为注册
  插件与权限,由 Tauri 运行期验证。
- E2E(Playwright,需 `COMBO_CRUSH_BIN`):改用 API 前置创建工作区后,其余
  断言不变;跑通需真实 rune 环境,本环境 `crush` 未安装则自动跳过。
