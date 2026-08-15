import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';

const hasCli = !!process.env.COMBO_CLI_BIN;

test.describe('多会话并发', () => {
  test.skip(!hasCli, 'set COMBO_CLI_BIN to opt in to e2e (needs a working provider/API key)');

  test('跨项目并发运行:切换项目后可继续发起,切回后运行态与历史完整', async ({
    page,
  }) => {
    // 两个独立的项目目录,模拟「一个任务在跑时去另一个目录发起新任务」
    const root = process.env.COMBO_IT_DIR ?? '/tmp/combo-e2e';
    const dirA = `${root}-multi-a`;
    const dirB = `${root}-multi-b`;
    for (const d of [dirA, dirB]) {
      mkdirSync(d, { recursive: true });
    }

    await page.goto('/');
    await expect(page.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15_000 });

    const cid = randomUUID();
    await page.evaluate(
      async ({ dirs, clientId }) => {
        localStorage.setItem('combo.clientId', clientId);
        for (const dir of dirs) {
          await fetch(`http://127.0.0.1:18236/v1/workspaces?client_id=${clientId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dir, client_id: clientId }),
          });
        }
      },
      { dirs: [dirA, dirB], clientId: cid }
    );

    const nameA = dirA.split('/').filter(Boolean).pop()!;
    const nameB = dirB.split('/').filter(Boolean).pop()!;
    const box = page.getByPlaceholder(/向 combo 提问/);

    // 项目 A 发起第一个任务
    await expect(page.getByText(nameA, { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByText(nameA, { exact: true }).click();
    await box.fill('任务A:简单回复一句话即可');
    await page.getByRole('button', { name: '发送' }).click();

    // A 运行中切到项目 B:仍能发起新会话(多会话并发的核心诉求)
    await page.getByText(nameB, { exact: true }).click();
    await box.fill('任务B:简单回复一句话即可');
    await page.getByRole('button', { name: '发送' }).click();
    // B 的回复开始流式输出
    await expect(page.getByRole('log')).toContainText('Agent', { timeout: 60_000 });
    // B 运行完成
    await expect(page.getByText(/finish:|done/).first()).toBeVisible({ timeout: 120_000 });

    // 切回项目 A:任务在未订阅期间结束后,运行态不卡死、历史完整,
    // 且可以再次发起(输入坞未被「运行中」锁死)
    await page.getByText(nameA, { exact: true }).click();
    await page.getByRole('button', { name: '任务A:简单回复一句话即可' }).first().click();
    await expect(page.getByText('任务A:简单回复一句话即可').first()).toBeVisible({
      timeout: 15_000,
    });
    await box.fill('任务A第二轮:继续简单回复');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByText(/finish:|done/).first()).toBeVisible({ timeout: 120_000 });
  });
});
