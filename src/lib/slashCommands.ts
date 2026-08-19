/**
 * Composer 斜杠命令:输入 `/` 触发命令菜单(useMention 的 command 类型),
 * 回车发送时由 Composer 拦截执行——不再把命令文本发给 LLM。
 *
 * 两类命令:
 * - `local`:前端本地执行(new/clear),不产生 agent run;
 * - `prompt`:展开为固定提示词,经正常发送流程交给 agent(summary/review/tests)。
 *
 * 命令后的剩余文本作为参数(args)传给处理器;prompt 类命令会把参数
 * 附加到提示词末尾(如 `/summary 重点看代码部分`)。
 * 未注册的 `/xxx`(如路径 `/usr/bin`)不拦截,照常作为普通消息发送。
 */

export type SlashCommandKind = 'local' | 'prompt';

export interface SlashCommandDef {
  id: string;
  label: string;
  description: string;
  kind: SlashCommandKind;
  /** local 类命令是否要求已有活跃会话(无会话时前端提示并忽略) */
  requiresSession?: boolean;
  /** prompt 类命令的提示词模板(args 为命令后附加的参数,可为空串) */
  prompt?: (args: string) => string;
}

/** 拼接提示词模板与可选的用户参数 */
function withArgs(base: string, args: string): string {
  const extra = args.trim();
  return extra ? `${base}\n\n${extra}` : base;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    id: 'new',
    label: '/new',
    description: '开始新的任务',
    kind: 'local',
  },
  {
    id: 'clear',
    label: '/clear',
    description: '清空当前对话上下文',
    kind: 'local',
    requiresSession: true,
  },
  {
    id: 'summary',
    label: '/summary',
    description: '总结当前对话内容',
    kind: 'prompt',
    prompt: (args) =>
      withArgs(
        '请总结当前对话的主要内容,包括:已完成的工作、关键决策与结论、当前状态以及后续待办事项。要求条理清晰,按要点列出。',
        args,
      ),
  },
  {
    id: 'review',
    label: '/review',
    description: '审查代码变更',
    kind: 'prompt',
    prompt: (args) =>
      withArgs(
        '请审查当前工作区的代码变更(查看 git diff 与暂存区),指出潜在问题、风险与改进建议,按严重程度从高到低排列。',
        args,
      ),
  },
  {
    id: 'tests',
    label: '/tests',
    description: '运行项目测试',
    kind: 'prompt',
    prompt: (args) =>
      withArgs(
        '请运行本项目的测试并汇报结果:执行了哪些测试、通过/失败数量、失败原因分析以及修复建议。',
        args,
      ),
  },
];

const BY_ID = new Map(SLASH_COMMANDS.map((c) => [c.id, c]));

export function getSlashCommand(id: string): SlashCommandDef | undefined {
  return BY_ID.get(id);
}

/**
 * 解析输入文本首部的斜杠命令:文本以 `/id` 开头(id 为首个空白分隔的
 * token)且已注册时命中,返回命令定义与其后的参数文本;否则返回 null。
 * 大小写敏感(命令均为小写);`/` 前有其他字符的文本不拦截。
 */
export function parseSlashCommand(
  text: string,
): { command: SlashCommandDef; args: string } | null {
  if (!text.startsWith('/')) return null;
  const sep = text.search(/\s/);
  const token = sep < 0 ? text.slice(1) : text.slice(1, sep);
  const command = BY_ID.get(token);
  if (!command) return null;
  const args = sep < 0 ? '' : text.slice(sep + 1).trim();
  return { command, args };
}
