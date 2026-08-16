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
