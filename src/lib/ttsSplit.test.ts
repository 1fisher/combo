import { describe, expect, it } from 'vitest';
import { splitSentences } from './ttsSplit';

describe('splitSentences', () => {
  it('按中文句末标点切句', () => {
    const { sentences, rest } = splitSentences('今天天气很好。明天也不错！后天呢？');
    expect(sentences).toEqual(['今天天气很好。', '明天也不错！', '后天呢？']);
    expect(rest).toBe('');
  });

  it('英文标点与换行同样切句', () => {
    const { sentences, rest } = splitSentences('Hello! How are you?\nFine.');
    expect(sentences).toEqual(['Hello!', ' How are you?', 'Fine.']);
    expect(rest).toBe('');
  });

  it('未成句的尾部保留在 rest(供下一轮增量拼接)', () => {
    const { sentences, rest } = splitSentences('今天天气');
    expect(sentences).toEqual([]);
    expect(rest).toBe('今天天气');
    // 第二轮增量
    const r2 = splitSentences(rest + '很好。');
    expect(r2.sentences).toEqual(['今天天气很好。']);
    expect(r2.rest).toBe('');
  });

  it('代码块围栏内内容不朗读、不切句', () => {
    const { sentences, rest } = splitSentences(
      '答案如下\n```python\nx = 1\nprint(x)\n```\n结果是 1。'
    );
    expect(sentences).toEqual(['答案如下\n', '结果是 1。']);
    expect(rest).toBe('');
  });

  it('围栏状态跨增量保留(rest 携带围栏标记)', () => {
    const first = splitSentences('答案如下\n```python\nx = 1');
    expect(first.sentences).toEqual(['答案如下\n']);
    // rest 必须包含 ``` 开头,下一轮才能重新进入围栏态
    expect(first.rest.startsWith('```')).toBe(true);
    const second = splitSentences(first.rest + '\nprint(x)\n```\n结果是 1。');
    expect(second.sentences).toEqual(['结果是 1。']);
    expect(second.rest).toBe('');
  });

  it('未闭合围栏的剩余内容留在 rest(由调用方在 run 结束时丢弃)', () => {
    const { sentences, rest } = splitSentences('答案如下\n```python\nx = 1');
    expect(sentences).toEqual(['答案如下\n']);
    expect(rest.includes('x = 1')).toBe(true);
  });

  it('超长单句强制切分(默认 100 字符)', () => {
    const long = '甲'.repeat(120);
    const { sentences, rest } = splitSentences(long);
    expect(sentences.length).toBe(1);
    expect(sentences[0].length).toBe(100);
    expect(rest.length).toBe(20);
  });

  it('空白候选不输出(连续换行)', () => {
    const { sentences, rest } = splitSentences('第一句。\n\n\n第二句。');
    expect(sentences).toEqual(['第一句。', '第二句。']);
    expect(rest).toBe('');
  });
});
