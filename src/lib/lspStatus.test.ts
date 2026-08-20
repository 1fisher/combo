import { describe, expect, it } from 'vitest';
import { computeLspIssues, computeLspReady, langLabel, suggestedCommand } from './lspStatus';
import type { Api } from './api/types';

function lang(l: string, files: number): Api.WorkspaceLanguageStat {
  return { lang: l, files };
}

function server(name: string, executable?: boolean): Api.LspServer {
  return { name, command: `${name}-server`, executable };
}

describe('langLabel', () => {
  it('映射常见语言', () => {
    expect(langLabel('rust')).toBe('Rust');
    expect(langLabel('typescript')).toBe('TypeScript');
    expect(langLabel('cpp')).toBe('C++');
    expect(langLabel('bash')).toBe('Shell');
  });
  it('未收录语言回退首字母大写', () => {
    expect(langLabel('elixir')).toBe('Elixir');
  });
});

describe('suggestedCommand', () => {
  it('给出常见语言的建议 server', () => {
    expect(suggestedCommand('rust')).toBe('rust-analyzer');
    expect(suggestedCommand('go')).toBe('gopls');
    expect(suggestedCommand('unknown-lang')).toBeUndefined();
  });
});

describe('computeLspIssues', () => {
  it('空语言列表返回空', () => {
    expect(computeLspIssues([], [server('rust', true)])).toEqual([]);
  });

  it('未配置 → missing,已配置但找不到可执行文件 → not-found,正常 → 无提示', () => {
    const issues = computeLspIssues(
      [lang('rust', 100), lang('typescript', 50), lang('python', 10)],
      [
        server('rust', false), // 配置了 rust-analyzer 但 PATH 找不到 → 报错
        server('typescript', true), // 正常 → 不提示
        // python 未配置 → missing
      ],
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ lang: 'rust', kind: 'not-found', command: 'rust-server', files: 100 });
    expect(issues[1]).toMatchObject({ lang: 'python', kind: 'missing', command: 'pyright-langserver', files: 10 });
  });

  it('executable 未回传(旧后端)时不误报', () => {
    const issues = computeLspIssues([lang('rust', 10)], [server('rust', undefined)]);
    expect(issues).toEqual([]);
  });

  it('文件数低于阈值或占比过小的语言被过滤', () => {
    const issues = computeLspIssues(
      [lang('rust', 200), lang('bash', 4), lang('go', 2)],
      [],
    );
    // bash 4 个但 < 200*5%=10;go 2 个 < MIN_FILES
    expect(issues.map((i) => i.lang)).toEqual(['rust']);
  });

  it('not-found 排在 missing 之前,同 kind 按文件数降序', () => {
    const issues = computeLspIssues(
      [lang('typescript', 80), lang('rust', 200), lang('python', 30)],
      [server('typescript', false)],
    );
    expect(issues.map((i) => `${i.lang}:${i.kind}`)).toEqual([
      'typescript:not-found',
      'rust:missing',
      'python:missing',
    ]);
  });

  it('最多提示 4 条', () => {
    const issues = computeLspIssues(
      [lang('rust', 100), lang('typescript', 90), lang('python', 80), lang('go', 70), lang('java', 60), lang('kotlin', 50)],
      [],
    );
    expect(issues).toHaveLength(4);
  });
});

describe('computeLspReady', () => {
  it('空语言列表返回空', () => {
    expect(computeLspReady([], [server('rust', true)])).toEqual([]);
  });

  it('已配置且可执行的语言进入就绪列表,带展示名与命令', () => {
    const ready = computeLspReady(
      [lang('rust', 100), lang('typescript', 50)],
      [server('rust', true), server('typescript', true)],
    );
    expect(ready).toEqual([
      { lang: 'rust', label: 'Rust', files: 100, command: 'rust-server' },
      { lang: 'typescript', label: 'TypeScript', files: 50, command: 'typescript-server' },
    ]);
  });

  it('可执行缺失或未配置的语言不计入就绪', () => {
    const ready = computeLspReady(
      [lang('rust', 100), lang('python', 20)],
      [server('rust', false)], // python 未配置
    );
    expect(ready).toEqual([]);
  });

  it('executable 未回传(旧后端)时视为就绪', () => {
    const ready = computeLspReady([lang('rust', 10)], [server('rust', undefined)]);
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ lang: 'rust', command: 'rust-server' });
  });

  it('与问题列表共用主要语言过滤(零散语言不展示)', () => {
    const languages = [lang('rust', 200), lang('bash', 4)];
    const servers = [server('rust', true), server('bash', true)];
    expect(computeLspReady(languages, servers).map((r) => r.lang)).toEqual(['rust']);
  });

  it('按文件数降序,最多 4 条', () => {
    const ready = computeLspReady(
      [lang('rust', 100), lang('typescript', 90), lang('python', 80), lang('go', 70), lang('java', 60)],
      [server('rust', true), server('typescript', true), server('python', true), server('go', true), server('java', true)],
    );
    expect(ready.map((r) => r.lang)).toEqual(['rust', 'typescript', 'python', 'go']);
  });
});
