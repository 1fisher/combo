/**
 * 文件语言检测:根据文件路径(扩展名/文件名)或内容 shebang 推断
 * highlight.js 语言名,供工具结果(read/write 等)按文件类型做语法高亮。
 *
 * 语言名以 lowlight common 语言集为基准(python/rust/go/typescript/…),
 * 外加少量按需注册的语言(dart/scala/dockerfile/powershell,见 CodeView)。
 * 未映射或未注册的扩展名返回 null,调用方按纯文本渲染。
 */

/** 扩展名(小写)→ highlight.js 语言名 */
const EXT_TO_LANG: Record<string, string> = {
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  rs: 'rust',
  go: 'go',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  fs: 'fsharp',
  fsx: 'fsharp',
  rb: 'ruby',
  erb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  sc: 'scala',
  dart: 'dart',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  sql: 'sql',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  vue: 'xml',
  xaml: 'xml',
  plist: 'xml',
  resx: 'xml',
  csproj: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  command: 'bash',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff',
  vb: 'vbnet',
  m: 'objectivec',
  mm: 'objectivec',
  ino: 'arduino',
  ps1: 'powershell',
  psm1: 'powershell',
};

/** 特殊文件名(小写,无扩展名场景)→ highlight.js 语言名 */
const FILENAME_TO_LANG: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile',
  dockerfile: 'dockerfile',
  'dockerfile.dev': 'dockerfile',
  'dockerfile.prod': 'dockerfile',
  '.env': 'ini',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
};

/** 语言名 → 展示名(标题栏标签) */
const LANG_DISPLAY_NAME: Record<string, string> = {
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  fsharp: 'F#',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kotlin: 'Kotlin',
  scala: 'Scala',
  dart: 'Dart',
  lua: 'Lua',
  perl: 'Perl',
  r: 'R',
  sql: 'SQL',
  json: 'JSON',
  yaml: 'YAML',
  ini: 'INI',
  toml: 'TOML',
  xml: 'XML',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  markdown: 'Markdown',
  bash: 'Bash',
  graphql: 'GraphQL',
  diff: 'Diff',
  vbnet: 'VB.NET',
  objectivec: 'Objective-C',
  arduino: 'Arduino',
  powershell: 'PowerShell',
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
};

/**
 * 根据文件路径推断 highlight.js 语言名。
 * 优先匹配特殊文件名(makefile/dockerfile 等),再按扩展名查表;
 * 识别不了返回 null(调用方按纯文本或继续走 shebang 检测)。
 */
export function langFromPath(path: string): string | null {
  const base = (path.split(/[\\/]/).pop() ?? '').trim().toLowerCase();
  if (!base) return null;
  const byName = FILENAME_TO_LANG[base];
  if (byName && byName !== 'toml-placeholder') return byName;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null; // 无扩展名(或 .env 这类已按文件名命中)
  const ext = base.slice(dot + 1);
  return EXT_TO_LANG[ext] ?? null;
}

/**
 * 根据内容首行 shebang(`#!/usr/bin/env python3` 等)推断语言。
 * 用于无扩展名或扩展名未映射的文件内容兜底。
 */
export function langFromShebang(content: string): string | null {
  const first = content.split('\n', 1)[0] ?? '';
  if (!first.startsWith('#!')) return null;
  if (/\bpython[\d.]*\b/.test(first)) return 'python';
  if (/\bnode\b/.test(first)) return 'javascript';
  if (/\bruby\b/.test(first)) return 'ruby';
  if (/\bperl\b/.test(first)) return 'perl';
  if (/\b(bash|sh|zsh|dash|ksh)\b/.test(first)) return 'bash';
  return null;
}

/** 语言的友好展示名(未映射时原样返回) */
export function langDisplayName(lang: string): string {
  return LANG_DISPLAY_NAME[lang] ?? lang;
}
