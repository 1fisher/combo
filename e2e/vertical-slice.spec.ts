import { mkdirSync, rmSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const hasCrush = !!process.env.COMBO_CRUSH_BIN;

test.describe('M1 vertical slice', () => {
  test.skip(!hasCrush, 'set COMBO_CRUSH_BIN to run against a real rune server');

  test('create workspace -> session -> agent run -> permission dialog', async ({
    page,
  }) => {
    // 预置:确保存在一个可用的 workspace 路径(用临时目录)
    const tmp = process.env.COMBO_IT_DIR ?? '/tmp/combo-e2e';
    // rune 会在工作区目录内持久化状态(.crush/),每次运行前清空,避免会话序号/标题残留
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });

    await page.goto('/');
    await expect(page.getByText('已连接 rune')).toBeVisible({ timeout: 15_000 });

    // 添加项目
    await page.getByPlaceholder('输入项目路径').fill(tmp);
    await page.getByRole('button', { name: '添加项目' }).click();
    const wsRow = page.getByText(tmp);
    await expect(wsRow).toBeVisible({ timeout: 15_000 });

    // 激活工作区
    await wsRow.click();

    // 新建会话
    await page.getByTitle('新建会话').click();
    await expect(page.getByText('会话 1')).toBeVisible({ timeout: 15_000 });

    // 发送任务
    await page.getByPlaceholder(/给 agent 下任务/).fill('执行 pwd 并返回当前目录');
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
