import { describe, expect, it } from 'vitest';
import { autoTitleFor, isPlaceholderTitle, titleFromPrompt } from './autoTitle';

describe('isPlaceholderTitle', () => {
  it('识别「新建任务」生成的占位标题', () => {
    expect(isPlaceholderTitle('会话 1')).toBe(true);
    expect(isPlaceholderTitle('会话 8')).toBe(true);
    expect(isPlaceholderTitle('会话100')).toBe(true);
    expect(isPlaceholderTitle('新任务')).toBe(true);
  });

  it('空标题视为占位', () => {
    expect(isPlaceholderTitle(undefined)).toBe(true);
    expect(isPlaceholderTitle(null)).toBe(true);
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle('   ')).toBe(true);
  });

  it('语义化标题不是占位,不会被覆盖', () => {
    expect(isPlaceholderTitle('修复登录页面的表单校验')).toBe(false);
    expect(isPlaceholderTitle('帮我写一个快速排序算法')).toBe(false);
    expect(isPlaceholderTitle('会话整理工具')).toBe(false);
  });
});

describe('titleFromPrompt', () => {
  it('取需求前 20 字', () => {
    expect(titleFromPrompt('帮我写一个快速排序算法')).toBe('帮我写一个快速排序算法');
    expect(titleFromPrompt('帮我修复登录页面的表单校验并补充单元测试用例以及回归验证')).toBe(
      '帮我修复登录页面的表单校验并补充单元测试'
    );
  });

  it('空需求回退「新任务」', () => {
    expect(titleFromPrompt('')).toBe('新任务');
    expect(titleFromPrompt('   ')).toBe('新任务');
  });
});

describe('autoTitleFor', () => {
  it('占位标题 → 返回需求标题', () => {
    expect(autoTitleFor('帮我写一个快速排序算法', '会话 1')).toBe('帮我写一个快速排序算法');
    expect(autoTitleFor('修复登录页面', '新任务')).toBe('修复登录页面');
    expect(autoTitleFor('需求', undefined)).toBe('需求');
  });

  it('语义化标题(用户已重命名)→ 不覆盖', () => {
    expect(autoTitleFor('帮我写一个快速排序算法', '我的排序任务')).toBeNull();
    expect(autoTitleFor('帮我写一个快速排序算法', '会话整理工具')).toBeNull();
  });

  it('新标题与当前一致 → 不重复重命名', () => {
    expect(autoTitleFor('帮我写一个快速排序算法', '帮我写一个快速排序算法')).toBeNull();
  });

  it('空需求且占位标题 → 回退「新任务」', () => {
    expect(autoTitleFor('', '会话 1')).toBe('新任务');
  });
});
