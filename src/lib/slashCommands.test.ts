import { describe, expect, it } from 'vitest';
import { parseSlashCommand, SLASH_COMMANDS } from './slashCommands';

describe('parseSlashCommand', () => {
  it('解析无参数的已知命令', () => {
    expect(parseSlashCommand('/clear')).toEqual({
      command: SLASH_COMMANDS.find((c) => c.id === 'clear'),
      args: '',
    });
    expect(parseSlashCommand('/new')?.command.id).toBe('new');
  });

  it('解析带参数的命令(空格分隔,参数保留原文)', () => {
    const hit = parseSlashCommand('/summary 重点看代码部分');
    expect(hit?.command.id).toBe('summary');
    expect(hit?.args).toBe('重点看代码部分');
  });

  it('命令后换行的多行文本作为参数', () => {
    const hit = parseSlashCommand('/tests\n只跑 Rust');
    expect(hit?.command.id).toBe('tests');
    expect(hit?.args).toBe('只跑 Rust');
  });

  it('未注册命令不拦截(照常发送给 LLM)', () => {
    expect(parseSlashCommand('/usr/bin')).toBeNull();
    expect(parseSlashCommand('/foo bar')).toBeNull();
  });

  it('不以 / 开头的文本不拦截', () => {
    expect(parseSlashCommand('hello /clear')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('普通消息')).toBeNull();
  });

  it('大小写敏感(/CLEAR 不命中)', () => {
    expect(parseSlashCommand('/CLEAR')).toBeNull();
  });

  it('仅有斜杠不命中', () => {
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('/ ')).toBeNull();
  });

  it('prompt 类命令的模板拼接参数', () => {
    const cmd = SLASH_COMMANDS.find((c) => c.id === 'summary');
    expect(cmd?.kind).toBe('prompt');
    expect(cmd?.prompt?.('补充要求')).toContain('补充要求');
    expect(cmd?.prompt?.('')).not.toContain('\n\n');
  });

  it('local 类命令定义了 requiresSession', () => {
    expect(SLASH_COMMANDS.find((c) => c.id === 'clear')?.requiresSession).toBe(true);
    expect(SLASH_COMMANDS.find((c) => c.id === 'new')?.kind).toBe('local');
  });
});
