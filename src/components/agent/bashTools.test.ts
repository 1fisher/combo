import { describe, expect, it } from 'vitest';
import { commandFromInput, stripCommandEcho } from './bashTools';

describe('commandFromInput', () => {
  it('提取 command/cmd/script 字段', () => {
    expect(commandFromInput('{"command":"ls"}')).toBe('ls');
    expect(commandFromInput('{"cmd":"pwd"}')).toBe('pwd');
    expect(commandFromInput('{"script":"echo hi"}')).toBe('echo hi');
  });

  it('非 JSON 或无命令字段返回 null', () => {
    expect(commandFromInput('not json')).toBeNull();
    expect(commandFromInput('{"path":"a.ts"}')).toBeNull();
  });
});

describe('stripCommandEcho', () => {
  it('剥离与命令一致的首行回显', () => {
    expect(stripCommandEcho('$ cargo test\nrunning 1 test\n✅ 命令执行成功', 'cargo test')).toBe(
      'running 1 test\n✅ 命令执行成功',
    );
  });

  it('多行命令的回显整体剥离', () => {
    const cmd = 'echo a\necho b';
    expect(stripCommandEcho(`$ ${cmd}\nout`, cmd)).toBe('out');
  });

  it('首行不是该命令回显时原样返回', () => {
    expect(stripCommandEcho('$ other\nout', 'cargo test')).toBe('$ other\nout');
  });

  it('无命令时原样返回', () => {
    expect(stripCommandEcho('$ ls\nfile', null)).toBe('$ ls\nfile');
  });
});
