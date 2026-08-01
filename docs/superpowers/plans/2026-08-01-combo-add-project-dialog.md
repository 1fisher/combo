# 添加项目目录选择对话框 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点击「添加项目」弹出原生目录选择对话框(Tauri 桌面模式),浏览器模式改为提示,移除路径输入框。

**Architecture:** 桌面壳注册 `tauri-plugin-dialog` 并授予 `dialog:allow-open` 权限;前端 `WorkspaceSidebar` 用 `isTauri()` 分流——Tauri 下动态 import `open({ directory: true })` 取绝对路径后 `create`,浏览器下提示「请在桌面版中选择项目目录」。E2E 因浏览器拿不到绝对路径,改为经 API 前置创建工作区。

**Tech Stack:** Tauri v2 + `tauri-plugin-dialog`(Rust crate `2.x` / npm `^2.2.0`,npm 包已在 `package.json`)、React 19 + Vitest + Testing Library、Playwright。

## Global Constraints

- UI 文案用中文;按钮文案固定为「添加项目」,加载态「选择中…」,浏览器提示「请在桌面版中选择项目目录」。
- 不新增任何自定义 Tauri command;只用官方 `tauri-plugin-dialog` 的 `open`。
- `client_id` 在 `createWorkspace` 请求的 body 与 query 中都必须存在(rune 从 body 校验)。
- `@/*` 别名 → `./src/*`;kebab-case 文件名、PascalCase 组件。
- 保持 `WorkspaceSidebar` 现有 JSX 结构风格(tailwind 类、lucide 图标 `FolderPlus`)。

---

### Task 1: Tauri 注册 dialog 插件

**Files:**
- Modify: `src-tauri/Cargo.toml`(dependencies 段)
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: 无
- Produces: 前端可在 Tauri 模式下调用 `@tauri-apps/plugin-dialog` 的 `open()`(JS 侧已随 npm 包分发,无需额外注册)

- [ ] **Step 1: 给 `src-tauri/Cargo.toml` 的 `[dependencies]` 增加一行**

```toml
tauri-plugin-dialog = "2"
```

- [ ] **Step 2: 在 `src-tauri/src/lib.rs` 注册插件**

在 `tauri::Builder::default()` 与 `.setup(...)` 之间插入 `.plugin(...)` 调用,改为:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
```

- [ ] **Step 3: 给 `src-tauri/capabilities/default.json` 增加权限**

`permissions` 数组改为 `["core:default", "dialog:allow-open"]`(只授 open,不授 save)。

- [ ] **Step 4: 编译验证**

Run: `cargo check -p combo`
Expected: 编译通过,无 error/warning。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat: register tauri dialog plugin for directory picking"
```

---

### Task 2: 前端「添加项目」改为目录选择

**Files:**
- Modify: `src/components/shell/WorkspaceSidebar.tsx`
- Test: `src/components/shell/WorkspaceSidebar.test.tsx`

**Interfaces:**
- Consumes: `isTauri()` from `src/lib/connection.ts:13`;`create` from `useWorkspaces()`(即 `createWorkspace(path): Promise<Api.Workspace>`);`@tauri-apps/plugin-dialog` 的 `open(opts): Promise<string | string[] | null>`
- Produces: `WorkspaceSidebar` 不再有路径输入框;「添加项目」按钮点击触发 `onPickDirectory()`(组件内部函数,无外部依赖)

- [ ] **Step 1: 先改测试——新增/改写用例**

将 `src/components/shell/WorkspaceSidebar.test.tsx` 整体替换为:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceSidebar } from './WorkspaceSidebar';
import { isTauri } from '../../lib/connection';
import { open } from '@tauri-apps/plugin-dialog';

const workspaces: { id: string; path: string }[] = [
  { id: 'w1', path: '/proj/a' },
  { id: 'w2', path: '/proj/b' },
];

vi.mock('../../lib/api', () => ({
  listWorkspaces: vi.fn(async () => [...workspaces]),
  createWorkspace: vi.fn(async (path: string) => {
    const w = { id: `w${workspaces.length + 1}`, path };
    workspaces.push(w);
    return w;
  }),
}));

vi.mock('../../lib/connection', () => ({
  isTauri: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <WorkspaceSidebar />
    </QueryClientProvider>
  );
}

describe('WorkspaceSidebar', () => {
  it('renders workspaces from API', async () => {
    wrap();
    expect(await screen.findByText('/proj/a')).toBeTruthy();
    expect(screen.getByText('/proj/b')).toBeTruthy();
  });

  it('creates a workspace from the picked directory (Tauri)', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(open).mockResolvedValue('/proj/c');
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(await screen.findByText('/proj/c')).toBeTruthy();
    expect(open).toHaveBeenCalledWith({ directory: true, multiple: false });
  });

  it('shows a hint in browser mode', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(await screen.findByText('请在桌面版中选择项目目录')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it('does nothing when the dialog is cancelled', async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(open).mockResolvedValue(null);
    wrap();
    await userEvent.click(await screen.findByRole('button', { name: '添加项目' }));
    expect(screen.queryByText('/proj/c')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/shell/WorkspaceSidebar.test.tsx`
Expected: FAIL——组件还没有 `onPickDirectory`,输入框仍存在(`findByRole('button', { name: '添加项目' })` 因 disabled 可能仍可找到,但 Tauri 用例断言 `open` 被调用、以及 `findByText('/proj/c')` 不会出现)。

- [ ] **Step 3: 改写 `WorkspaceSidebar.tsx`**

3a. 修改 import 段:

```tsx
import { useEffect, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useAgentStore } from '../../stores/agentStore';
import { useEditorStore } from '../../stores/editorStore';
import { getFileContent } from '../../lib/api';
import { isTauri } from '../../lib/connection';
import { FileExplorer } from '../editor/FileExplorer';
import { cn } from '../../lib/utils';
```

(删除 `import { Input } from '../ui/input';`,新增 `import { isTauri } from '../../lib/connection';`)

3b. state:`const [path, setPath] = useState('');` 替换为 `const [picking, setPicking] = useState(false);`

3c. `onCreate` 函数整体替换为:

```tsx
  async function onPickDirectory() {
    setFileError(null);
    if (!isTauri()) {
      setFileError('请在桌面版中选择项目目录');
      return;
    }
    setPicking(true);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, multiple: false });
      if (typeof dir === 'string') {
        await create(dir);
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  }
```

3d. 空状态文案(第 93 行附近)改为:

```tsx
还没有项目。点击「添加项目」选择项目目录,然后从文件树打开文件。
```

3e. 底部「添加项目」区块(第 107-121 行)整体替换为:

```tsx
      {!activeWs && (
        <div className="border-t p-2">
          <Button size="sm" className="w-full" onClick={onPickDirectory} disabled={picking}>
            <FolderPlus className="h-3.5 w-3.5" />
            {picking ? '选择中…' : '添加项目'}
          </Button>
        </div>
      )}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/shell/WorkspaceSidebar.test.tsx`
Expected: 4 个用例全部 PASS。

- [ ] **Step 5: 类型检查**

Run: `npm run tsc`
Expected: 无类型错误。

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/WorkspaceSidebar.tsx src/components/shell/WorkspaceSidebar.test.tsx
git commit -m "feat: pick project directory via native dialog instead of typing a path"
```

---

### Task 3: E2E 改为 API 前置创建工作区

**Files:**
- Modify: `e2e/vertical-slice.spec.ts`

**Interfaces:**
- Consumes: 无(独立改动);浏览器模式下「添加项目」按钮不再可用,故移除该 UI 步骤
- Produces: e2e 在进入页面后、激活工作区前,经 `POST /v1/workspaces` 创建好工作区,后续断言不变

- [ ] **Step 1: 改 import 段**

在 `import { mkdirSync, rmSync } from 'node:fs';` 之后加一行:

```ts
import { randomUUID } from 'node:crypto';
```

- [ ] **Step 2: 替换「添加项目」步骤(第 21-25 行)**

```ts
    // 添加项目:浏览器模式无法弹原生目录对话框,经 API 前置创建工作区
    const cid = randomUUID();
    await page.evaluate(
      async ({ dir, clientId }) => {
        localStorage.setItem('combo.clientId', clientId);
        await fetch(`http://127.0.0.1:18234/v1/workspaces?client_id=${clientId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir, client_id: clientId }),
        });
      },
      { dir: tmp, clientId: cid }
    );
    const wsRow = page.getByText(tmp);
    await expect(wsRow).toBeVisible({ timeout: 15_000 });
```

- [ ] **Step 3: 运行完整前端测试套件(确认未破坏其他用例)**

Run: `npm test`
Expected: 全部 PASS(e2e 未设 `COMBO_CRUSH_BIN`,自动跳过)。

- [ ] **Step 4: Commit**

```bash
git add e2e/vertical-slice.spec.ts
git commit -m "test: create e2e workspace via API since browser mode has no directory dialog"
```

---

### Task 4: 更新 AGENTS.md 选择器说明

**Files:**
- Modify: `AGENTS.md:159-161`

**Interfaces:**
- Consumes: 无
- Produces: 文档与新的添加项目流程一致

- [ ] **Step 1: 改写 E2E 选择器说明**

原:

```
  UI text (e.g. `getByPlaceholder('输入项目路径')`, button `添加项目`, `发送`,
  title `新建会话`).
```

改为:

```
  UI text (e.g. button `添加项目`, `发送`, title `新建会话`).「添加项目」在
  桌面模式弹原生目录对话框,浏览器模式仅提示;e2e 改为经 API 创建工作区.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update e2e selector notes for directory-picker project creation"
```

---

### Task 5: 全量验证

**Files:** 无改动

- [ ] **Step 1: 运行全部前端测试**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 2: 类型检查**

Run: `npm run tsc`
Expected: 无错误。

- [ ] **Step 3: Rust 编译检查**

Run: `cargo check -p combo`
Expected: 编译通过。

- [ ] **Step 4: 复核全局约束**

逐条核对:中文文案、无自定义 command、`client_id` body+query、别名与命名、JSX 风格、`WorkspaceSidebar` 无残留 `Input`/`path` 引用(`grep -rn "输入项目路径\|setPath\|Input" src/components/shell/WorkspaceSidebar.tsx` 应无 `输入项目路径`/`setPath` 命中)。

---

## Self-Review 记录

- **Spec 覆盖:** §3.1(src-tauri 三处改动)→ Task 1;§3.2(组件改造)→ Task 2;§3.3(e2e + 组件测试 + AGENTS.md)→ Task 2/3/4;§5 错误处理(取消静默、报错入 fileError、浏览器提示)→ Task 2 的 `onPickDirectory`;§6 测试计划 → Task 2 四条用例 + Task 3 + Task 5。
- **占位符扫描:** 无 TBD/TODO;每个 Step 均含完整代码或精确命令。
- **类型一致性:** `open` 返回 `string | string[] | null`,统一用 `typeof dir === 'string'` 收窄;`isTauri()` 来自 `connection.ts`;`create` 签名 `(path: string) => Promise<Api.Workspace>` 与 Task 2 测试的 `createWorkspace` mock 一致。
