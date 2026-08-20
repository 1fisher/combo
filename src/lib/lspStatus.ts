import type { Api } from './api/types';

/**
 * 会话界面 LSP 状态展示的纯逻辑:
 * 把「workspace 语言统计」(GET /v1/workspaces/:id/languages)与
 * 「已配置 LSP server 列表」(GET /v1/lsp,含可执行实时检测)做交叉——
 * - computeLspIssues:项目主要语言中 LSP 未就绪的部分(未配置 / 可执行文件缺失),
 *   用于警示横幅;
 * - computeLspReady:已就绪的部分(已配置且可执行),配置齐全时在会话里
 *   正向展示「语言服务已就绪」,确认代码诊断/导航工具可用。
 */

/** 语言标识 → 展示名(与后端 ext_to_lang 对齐;未收录的回退为首字母大写)。 */
const LANG_LABELS: Record<string, string> = {
  rust: 'Rust',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  scala: 'Scala',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  bash: 'Shell',
  lua: 'Lua',
  dart: 'Dart',
};

/** 未配置时的建议 server 命令(与 LSP 视图模板/一键安装方案一致)。 */
const SUGGESTED_COMMANDS: Record<string, string> = {
  rust: 'rust-analyzer',
  typescript: 'typescript-language-server',
  javascript: 'typescript-language-server',
  python: 'pyright-langserver',
  go: 'gopls',
};

export function langLabel(lang: string): string {
  return LANG_LABELS[lang] ?? lang.charAt(0).toUpperCase() + lang.slice(1);
}

/** 未配置提示里展示的建议命令;未知语言返回 undefined。 */
export function suggestedCommand(lang: string): string | undefined {
  return SUGGESTED_COMMANDS[lang];
}

export type LspIssueKind = 'not-found' | 'missing';

export type LspIssue = {
  /** 语言标识(与 [lsp.<lang>] 配置键一致)。 */
  lang: string;
  /** 展示名,如 Rust/TypeScript。 */
  label: string;
  /** 该语言源文件数(佐证「项目是 rust」)。 */
  files: number;
  kind: LspIssueKind;
  /** not-found:已配置但找不到的命令;missing:建议配置的命令。 */
  command?: string;
};

/** 主要语言中 LSP 已就绪的部分(会话界面的正向状态展示)。 */
export type LspReady = {
  /** 语言标识(与 [lsp.<lang>] 配置键一致)。 */
  lang: string;
  /** 展示名,如 Rust/TypeScript。 */
  label: string;
  /** 该语言源文件数。 */
  files: number;
  /** 已配置且可执行的 server 命令。 */
  command: string;
};

/** 文件数低于该值的语言不提示(避免仓库里零散脚本造成噪音)。 */
const MIN_FILES = 3;
/** 相对最多语言的最小占比(5%),过滤掉只占零头的语言。 */
const MIN_SHARE = 0.05;
/** 最多同时提示的语言数。 */
const MAX_ISSUES = 4;
/** 就绪列表最多展示的语言数(与问题列表同阈值,避免噪音)。 */
const MAX_READY = 4;

/**
 * 项目「主要语言」:过滤零散语言(绝对数量与相对占比都要过阈值)后的列表,
 * 问题提示与就绪展示共用同一口径,保证两者互补覆盖主要语言。
 * 入参按文件数降序(后端保证),过滤后保持该顺序。
 */
function meaningfulLanguages(
  languages: Api.WorkspaceLanguageStat[],
): Api.WorkspaceLanguageStat[] {
  if (languages.length === 0) return [];
  const top = Math.max(...languages.map((l) => l.files));
  return languages.filter((l) => l.files >= MIN_FILES && l.files >= top * MIN_SHARE);
}

/**
 * 计算项目主要语言中 LSP 未就绪的问题列表:
 * - `not-found`:已配置 server 但 `executable === false`(PATH 中找不到可执行文件);
 * - `missing`:项目有该语言的源码但未配置 server(代码诊断/导航工具不可用);
 * - 可执行正常(或旧后端未回传 executable)的语言不产生提示。
 *
 * 排序:not-found 优先于 missing,其次按文件数降序;最多 MAX_ISSUES 条。
 */
export function computeLspIssues(
  languages: Api.WorkspaceLanguageStat[],
  servers: Api.LspServer[],
): LspIssue[] {
  const issues: LspIssue[] = [];
  for (const { lang, files } of meaningfulLanguages(languages)) {
    const server = servers.find((s) => s.name === lang);
    if (!server) {
      issues.push({ lang, label: langLabel(lang), files, kind: 'missing', command: suggestedCommand(lang) });
    } else if (server.executable === false) {
      issues.push({ lang, label: langLabel(lang), files, kind: 'not-found', command: server.command });
    }
  }
  issues.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'not-found' ? -1 : 1;
    if (b.files !== a.files) return b.files - a.files;
    return a.lang.localeCompare(b.lang);
  });
  return issues.slice(0, MAX_ISSUES);
}

/**
 * 计算项目主要语言中 LSP 已就绪的列表(已配置 server 且可执行文件存在),
 * 供会话界面做正向状态展示,确认代码诊断/导航工具可用。
 * `executable` 未回传(旧后端)视为正常,与 computeLspIssues 的判定口径一致。
 * 按文件数降序,最多 MAX_READY 条。
 */
export function computeLspReady(
  languages: Api.WorkspaceLanguageStat[],
  servers: Api.LspServer[],
): LspReady[] {
  const ready: LspReady[] = [];
  for (const { lang, files } of meaningfulLanguages(languages)) {
    const server = servers.find((s) => s.name === lang);
    if (server && server.executable !== false) {
      ready.push({ lang, label: langLabel(lang), files, command: server.command });
    }
  }
  return ready.slice(0, MAX_READY);
}
