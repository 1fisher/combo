/** bash 类工具名:命令调用工具,输入/输出按终端语义渲染 */
export const BASH_TOOLS = new Set(['bash', 'run_shell_command']);

/**
 * 从 bash 类工具的输入 JSON 中提取命令文本(常见 key:command / cmd / script)。
 * 提不到(非 JSON 或无命令字段)返回 null,调用方回退到原渲染路径。
 */
export function commandFromInput(input: string): string | null {
  try {
    const j = JSON.parse(input) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    for (const key of ['command', 'cmd', 'script']) {
      const v = j[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
  } catch {
    /* 非 JSON,无法提取 */
  }
  return null;
}

/**
 * 去掉历史 tool_result 内容里回显的命令首行(`$ <command>`)。
 * 旧版后端 bash 工具会把命令以 `$ <command>\n` 拼进返回内容,而命令已由
 * 配对的 tool_call(ToolCallCard)单独渲染,这里剥离避免重复展示。
 * 仅在内容确实以该回显开头时才剥离,否则原样返回。
 */
export function stripCommandEcho(content: string, command: string | null): string {
  if (!command || !command.trim()) return content;
  const echo = `$ ${command}`;
  if (content.startsWith(echo)) {
    return content.slice(echo.length).replace(/^\r?\n/, '');
  }
  return content;
}

/**
 * 人类可读时长:15752 → "15.8s"、120s → "2分"、3800s → "1小时3分"。
 * 供 bash 类工具卡片的耗时展示使用。
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) {
    const s = Math.round(secs * 10) / 10;
    return `${s % 1 === 0 ? s.toFixed(0) : s.toFixed(1)}s`;
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    const rem = Math.floor(secs) % 60;
    return rem ? `${mins}分${rem}秒` : `${mins}分`;
  }
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}小时${rem}分` : `${hours}小时`;
}
