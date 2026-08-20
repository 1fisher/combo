import {
  Archive,
  Bot,
  CircleQuestionMark,
  Clock3,
  FilePenLine,
  FileText,
  Globe,
  Link2,
  ListTodo,
  LocateFixed,
  MessageSquareText,
  Replace,
  Search,
  Stethoscope,
  Terminal,
  TextSearch,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * 工具名 → 图标映射:tool_call 卡片按工具语义显示不同图标,
 * 便于在消息流中一眼区分 read / grep / search 等调用。
 * 图标选择与后端 `crates/combo-cli/src/tools.rs` 的内置工具一一对应;
 * 未收录的名字(MCP / 第三方工具)由 `toolIcon` 回退扳手。
 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  // 文件读写
  read: FileText,
  write: FilePenLine,
  replace: Replace,
  // 搜索类:search 内置逐文件搜索(放大镜),grep 走 ripgrep(文本搜索)
  search: Search,
  grep: TextSearch,
  // 终端(bash 类工具含 run_shell_command 别名)
  bash: Terminal,
  run_shell_command: Terminal,
  // 网络与时间
  web_search: Globe,
  current_datetime: Clock3,
  // 交互工具(CircleQuestionMark:circle-help 在 lucide 1.x 已改名,避免用别名)
  question: CircleQuestionMark,
  todo_write: ListTodo,
  compact: Archive,
  // 多 agent 协作(子任务派发)
  agent: Bot,
  // LSP 代码导航
  diagnostics: Stethoscope,
  definition: LocateFixed,
  references: Link2,
  hover: MessageSquareText,
};

/** 工具风险等级:决定图标颜色,体现副作用的危险程度 */
export type ToolRisk = 'safe' | 'info' | 'warn' | 'danger';

/**
 * 工具风险分级(颜色语义):
 * - safe(绿):只读无副作用——read/search/grep/web_search/时间/LSP 导航
 * - info(蓝):纯交互,不触碰磁盘——question/todo_write
 * - warn(黄):变更会话状态或派生动作,但不直接改文件——compact/agent
 * - danger(红):写文件或执行任意命令,有破坏性——write/replace/bash
 */
const TOOL_RISK: Record<string, ToolRisk> = {
  read: 'safe',
  search: 'safe',
  grep: 'safe',
  web_search: 'safe',
  current_datetime: 'safe',
  diagnostics: 'safe',
  definition: 'safe',
  references: 'safe',
  hover: 'safe',
  question: 'info',
  todo_write: 'info',
  compact: 'warn',
  agent: 'warn',
  write: 'danger',
  replace: 'danger',
  bash: 'danger',
  run_shell_command: 'danger',
};

const RISK_CLASSES: Record<ToolRisk, string> = {
  safe: 'text-green-500',
  info: 'text-brand',
  warn: 'text-amber-500',
  danger: 'text-red-500',
};

/** 按工具名取图标;未知工具(MCP 等)回退扳手 */
export function toolIcon(name: string): LucideIcon {
  return TOOL_ICONS[name] ?? Wrench;
}

/** 按工具名取图标颜色(风险语义);未知工具(MCP 等)用中性灰 */
export function toolIconClass(name: string): string {
  return RISK_CLASSES[TOOL_RISK[name] ?? ''] ?? 'text-muted-foreground';
}
