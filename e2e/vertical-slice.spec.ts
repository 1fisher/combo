import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

const hasCli = !!process.env.COMBO_CLI_BIN;

test.describe('M1 vertical slice', () => {
  test.skip(!hasCli, 'set COMBO_CLI_BIN to opt in to e2e (needs a working provider/API key)');

  test('create workspace -> session -> agent run -> permission dialog', async ({
    page,
  }) => {
    // 预置:确保存在一个可用的 workspace 路径(用临时目录)
    const tmp = process.env.COMBO_IT_DIR ?? '/tmp/combo-e2e';
    // 侧边栏显示项目名(basename),而不是完整路径
    const projName = tmp.split('/').filter(Boolean).pop()!;
    // 每次运行前清空,避免会话序号/标题残留
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });

    await page.goto('/');
    await expect(page.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });

    // 添加项目:浏览器模式无法弹原生目录对话框,经 API 前置创建工作区
    const cid = randomUUID();
    await page.evaluate(
      async ({ dir, clientId }) => {
        localStorage.setItem('combo.clientId', clientId);
        await fetch(`http://127.0.0.1:18234/v1/workspaces?client_id=${clientId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: dir, client_id: clientId, backend: 'combo-cli' }),
        });
      },
      { dir: tmp, clientId: cid }
    );
    const wsRow = page.getByText(projName, { exact: true });
    await expect(wsRow).toBeVisible({ timeout: 15_000 });

    // 激活工作区
    await wsRow.click();

    // 新建会话
    await page.getByTitle('新建会话').click();
    await expect(page.getByText('会话 1')).toBeVisible({ timeout: 15_000 });

    // 发送任务
    await page.getByPlaceholder(/向 combo 提问/).fill('执行 pwd 并返回当前目录');
    await page.getByRole('button', { name: '发送' }).click();

    // 等待工具调用卡片出现(可能触发权限弹窗;若出现则允许)
    const perm = page.getByText('权限请求', { exact: false });
    if (await perm.isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '允许' }).click();
    }
    await expect(page.getByText('⚙ bash').first()).toBeVisible({ timeout: 120_000 });

    // 等待运行完成(finish 消息或 run 状态消失)
    await expect(page.getByText(/finish:|done/).first()).toBeVisible({ timeout: 120_000 });
  });
});
