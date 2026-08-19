import { useEffect, useState } from 'react';
import {
  Braces,
  CheckCircle2,
  ChevronLeft,
  Cog,
  FileCode2,
  Loader2,
  Pencil,
  Plus,
  Rocket,
  ScanSearch,
  Terminal,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Button } from '../ui/button';
import { useLspActions, useLspServers } from '../../hooks/useLsp';
import { checkLspCommand } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { confirmDialog } from '../../lib/confirm';
import { cn } from '../../lib/utils';
import { HeroCard, HeroEmpty, INPUT_CLS, LABEL_CLS, PAGE, PageHeader, ViewScroll } from './PageShell';

/**
 * LSP 服务视图(主内容区独立视图,按 MCP 视图的设计思路):
 * - 无 server 时 hero 首页:常用语言模板卡片(rust/ts/python/go)直达表单并预填;
 * - 列表:server 卡片(语言标识 + 命令 + 可执行状态实时检测 + 操作);
 * - 表单:语言标识 + 启动命令(可即时检测)+ 参数 + 环境变量。
 *
 * 配置保存到 combo-cli.toml 的 [lsp.<lang>] 段,配置任意 server 后 agent
 * 自动获得 diagnostics/definition/references/hover 四个代码导航工具,
 * 按文件扩展名路由到对应语言的 server。
 */

type LspServer = Api.LspServer;

type Draft = {
  /** 语言标识(配置段名 [lsp.<名称>]) */
  name: string;
  /** 可执行文件(不含参数) */
  command: string;
  /** 参数串(空格分隔,支持引号包空白) */
  args: string;
  /** 环境变量,每行一条 KEY=VALUE */
  env: string;
};

function emptyDraft(): Draft {
  return { name: '', command: '', args: '', env: '' };
}

function draftFrom(s: LspServer): Draft {
  const env = Object.entries(s.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  return {
    name: s.name,
    command: s.command,
    args: (s.args ?? []).join(' '),
    env,
  };
}

/** 环境变量草稿(KEY=VALUE 行)→ 对象;格式非法时返回错误文案。 */
function parseEnv(text: string): { env?: Record<string, string>; error?: string } {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      return { error: `环境变量格式应为 KEY=VALUE:${line}` };
    }
    const k = line.slice(0, eq).trim();
    if (!/^[\w.-]+$/.test(k)) {
      return { error: `环境变量名仅支持字母、数字、"."、"-"、"_":${k}` };
    }
    out[k] = line.slice(eq + 1);
  }
  return { env: out };
}

type View = { kind: 'list' } | { kind: 'form'; editing: LspServer | null; preset?: Partial<Draft> };

/** 首页模板卡片:点击直达表单并预填 */
const TEMPLATES: { icon: typeof Cog; title: string; desc: string; preset: Partial<Draft> }[] = [
  {
    icon: Cog,
    title: 'Rust',
    desc: 'rust-analyzer,代码补全与诊断。',
    preset: { name: 'rust', command: 'rust-analyzer' },
  },
  {
    icon: Braces,
    title: 'TypeScript',
    desc: 'typescript-language-server,.ts/.tsx。',
    preset: { name: 'typescript', command: 'typescript-language-server', args: '--stdio' },
  },
  {
    icon: Terminal,
    title: 'Python',
    desc: 'pyright-langserver,.py 文件。',
    preset: { name: 'python', command: 'pyright-langserver', args: '--stdio' },
  },
  {
    icon: Rocket,
    title: 'Go',
    desc: 'gopls,Go 官方语言服务器。',
    preset: { name: 'go', command: 'gopls' },
  },
  {
    icon: Pencil,
    title: '自定义',
    desc: '跳过模板,手动配置语言与命令。',
    preset: {},
  },
];

/** 常用语言标识(与后端扩展名映射对齐),表单输入的 datalist 建议 */
const COMMON_LANGS = [
  'rust',
  'typescript',
  'javascript',
  'python',
  'go',
  'java',
  'kotlin',
  'scala',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'php',
  'swift',
  'bash',
  'lua',
  'dart',
];

/** 配置任意 LSP server 后 agent 自动获得的代码导航工具 */
const AGENT_TOOLS = ['diagnostics', 'definition', 'references', 'hover'];

/** 命令检测结果:found + 可执行文件路径 */
type CheckState = { checking: boolean; result?: Api.LspCheckResult; error?: string };

export function LspView() {
  const { data: servers, isLoading } = useLspServers();
  const { upsert, upserting, remove, removing } = useLspActions();

  const [view, setView] = useState<View>({ kind: 'list' });
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [err, setErr] = useState('');

  // 表单内命令即时检测(未保存也能确认命令可用)
  const [formCheck, setFormCheck] = useState<CheckState>({ checking: false });

  // 列表行内「检测命令」结果(语言标识 → 检测状态)
  const [checkingName, setCheckingName] = useState<string | null>(null);
  const [checkResults, setCheckResults] = useState<Record<string, Api.LspCheckResult>>({});
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});

  // 进入表单视图时初始化草稿:编辑对象优先,其次模板预设
  useEffect(() => {
    if (view.kind === 'form') {
      setDraft(
        view.editing ? draftFrom(view.editing) : { ...emptyDraft(), ...(view.preset ?? {}) },
      );
      setErr('');
      setFormCheck({ checking: false });
    }
  }, [view]);

  async function runCheck(command: string): Promise<Api.LspCheckResult> {
    return checkLspCommand(command);
  }

  /** 表单内:检测当前命令 */
  async function onFormCheck() {
    const command = draft.command.trim();
    if (!command) {
      setFormCheck({ checking: false, error: '请先填写启动命令' });
      return;
    }
    setFormCheck({ checking: true });
    try {
      const result = await runCheck(command);
      setFormCheck({ checking: false, result });
    } catch (e) {
      setFormCheck({ checking: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function handleSubmit() {
    const name = draft.name.trim();
    if (!name) return setErr('请填写语言标识');
    if (!draft.command.trim()) return setErr('请填写启动命令');
    if (draft.command.trim().split(/\s+/).length > 1)
      return setErr('启动命令只能是可执行文件本身,参数请写在「参数」一栏');
    const { env, error } = parseEnv(draft.env);
    if (error) return setErr(error);
    setErr('');
    try {
      await upsert({
        name,
        command: draft.command.trim(),
        args: draft.args.trim() || undefined,
        env: env && Object.keys(env).length > 0 ? env : undefined,
      });
      setView({ kind: 'list' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  /** 列表行内:对该 server 的命令发起检测 */
  async function onCheck(server: LspServer) {
    setCheckingName(server.name);
    setCheckResults((prev) => {
      const next = { ...prev };
      delete next[server.name];
      return next;
    });
    setCheckErrors((prev) => {
      const next = { ...prev };
      delete next[server.name];
      return next;
    });
    try {
      const result = await runCheck(server.command);
      setCheckResults((prev) => ({ ...prev, [server.name]: result }));
    } catch (e) {
      setCheckErrors((prev) => ({
        ...prev,
        [server.name]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setCheckingName(null);
    }
  }

  async function onRemove(server: LspServer) {
    if (!(await confirmDialog(`确定删除 LSP server「${server.name}」?`))) return;
    try {
      await remove(server.name);
      setCheckResults((prev) => {
        const next = { ...prev };
        delete next[server.name];
        return next;
      });
      setCheckErrors((prev) => {
        const next = { ...prev };
        delete next[server.name];
        return next;
      });
    } catch {
      // 删除失败时保留列表,用户可重试
    }
  }

  const busy = upserting;

  return (
    <ViewScroll>
      {/* ---------- 列表 / hero 首页 ---------- */}
      {view.kind === 'list' &&
        (isLoading ? (
          <div className={cn(PAGE)}>
            <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-foreground-subtle">
              <Loader2 className="size-4 animate-spin" /> 加载中…
            </div>
          </div>
        ) : !servers || servers.length === 0 ? (
          <HeroEmpty
            title="给 agent 装上代码导航"
            desc="LSP(Language Server Protocol)让 agent 获得诊断、跳转定义、查引用等代码能力。为项目语言配置一个 server,所有任务可用。"
          >
            <div className="relative z-10 mt-6 grid w-full max-w-2xl grid-cols-1 gap-4 px-4 sm:grid-cols-3">
              {TEMPLATES.map((t) => (
                <HeroCard
                  key={t.title}
                  icon={t.icon}
                  title={t.title}
                  desc={t.desc}
                  onClick={() => setView({ kind: 'form', editing: null, preset: t.preset })}
                />
              ))}
            </div>
          </HeroEmpty>
        ) : (
          <div className={cn(PAGE, 'gap-6')}>
            <PageHeader
              title="LSP 服务"
              desc="配置保存到 combo-cli.toml 的 [lsp.*] 段,新任务运行时自动加载。命令未安装时对应语言的工具不可用,可「检测命令」排查。"
            >
              <Button size="lg" onClick={() => setView({ kind: 'form', editing: null })}>
                <Plus /> 添加 server
              </Button>
            </PageHeader>

            {(servers ?? []).map((server) => {
              const checking = checkingName === server.name;
              // 行内检测优先展示(覆盖进入列表时的实时状态),否则用 GET 自带的 executable
              const result = checkResults[server.name];
              const error = checkErrors[server.name];
              const checked = result !== undefined || error !== undefined;
              const ok = checked ? result?.found === true : server.executable === true;
              return (
                <div
                  key={server.name}
                  className="group flex flex-col gap-4 rounded-xl border border-border bg-surface-hover/40 px-6 py-5 transition-colors hover:bg-surface-hover md:flex-row md:items-center md:gap-6"
                >
                  {/* 语言图标 */}
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-hover">
                    <FileCode2 className="size-5 text-brand" />
                  </span>

                  {/* 语言标识 + 命令行 + 检测结果 */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {server.name}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                          ok
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'bg-destructive/10 text-destructive',
                        )}
                        title={
                          ok
                            ? '命令已安装,任务中该语言的代码导航工具可用'
                            : '命令未找到,请先安装或检查路径'
                        }
                      >
                        {ok ? '已安装' : '未找到'}
                      </span>
                    </div>
                    <code className="mt-1 block truncate font-mono text-[13px] text-foreground-subtlest">
                      {[server.command, ...(server.args ?? [])].join(' ')}
                    </code>

                    {(checked || server.path) && !error && (
                      <p
                        className={cn(
                          'mt-1.5 truncate text-xs',
                          ok ? 'text-foreground-subtlest' : 'text-destructive/80',
                        )}
                        title={result?.path ?? server.path ?? ''}
                      >
                        {ok ? `可执行文件:${result?.path ?? server.path}` : 'PATH 中未找到该命令'}
                      </p>
                    )}
                    {error && (
                      <p className="mt-1.5 truncate text-xs text-destructive/80" title={error}>
                        检测失败:{error}
                      </p>
                    )}
                  </div>

                  {/* 操作 */}
                  <div className="flex shrink-0 items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={checking || removing}
                      onClick={() => void onCheck(server)}
                      title="在 PATH 中查找该命令"
                    >
                      {checking ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" /> 检测中…
                        </>
                      ) : (
                        <>
                          <ScanSearch className="size-3.5" /> 检测命令
                        </>
                      )}
                    </Button>
                    <div className="flex items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="编辑"
                        onClick={() => setView({ kind: 'form', editing: server })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="删除"
                        disabled={removing}
                        onClick={() => void onRemove(server)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}

            <p className="px-1 text-[13px] text-foreground-subtlest">
              共 {servers.length} 个 LSP server · 新任务运行时自动加载,按文件扩展名路由到对应语言
            </p>
          </div>
        ))}

      {/* ---------- 表单视图(双栏工作台,同 MCP 表单) ---------- */}
      {view.kind === 'form' && (
        <div className={cn(PAGE, 'min-h-full gap-6')}>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon-sm"
              title="返回列表"
              onClick={() => setView({ kind: 'list' })}
            >
              <ChevronLeft />
            </Button>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-foreground">
                {view.editing ? '编辑 LSP server' : '添加 LSP server'}
              </h2>
              <p className="mt-0.5 text-[13px] text-foreground-subtle">
                保存后写入 combo-cli.toml 的 [lsp.&lt;语言&gt;] 段,新任务运行时自动加载;可先「检测命令」确认已安装。
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {/* 左栏:基本信息 */}
            <section className="flex flex-col gap-5 rounded-xl border border-border bg-surface-hover/30 p-6">
              <h3 className="text-[13px] font-medium text-foreground-subtle">基本信息</h3>

              <div>
                <label className={LABEL_CLS}>语言标识</label>
                <input
                  className={INPUT_CLS}
                  list="lsp-lang-suggestions"
                  placeholder="如 rust、typescript(配置段名 [lsp.<语言>])"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
                <datalist id="lsp-lang-suggestions">
                  {COMMON_LANGS.map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
                <p className="mt-1.5 text-xs text-foreground-subtlest">
                  需与内置扩展名映射一致(rust→.rs、typescript→.ts/.tsx、python→.py……),agent 按它路由文件。
                </p>
              </div>

              <div>
                <label className={LABEL_CLS}>启动命令</label>
                <div className="flex gap-2">
                  <input
                    className={cn(INPUT_CLS, 'font-mono')}
                    placeholder="rust-analyzer"
                    value={draft.command}
                    onChange={(e) => {
                      setDraft({ ...draft, command: e.target.value });
                      setFormCheck({ checking: false });
                    }}
                  />
                  <Button
                    variant="outline"
                    className="shrink-0"
                    disabled={formCheck.checking}
                    onClick={() => void onFormCheck()}
                    title="在 PATH 中查找该命令"
                  >
                    {formCheck.checking ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ScanSearch className="size-3.5" />
                    )}
                    检测
                  </Button>
                </div>
                {formCheck.result && (
                  <p
                    className={cn(
                      'mt-1.5 flex items-center gap-1 text-xs',
                      formCheck.result.found
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-destructive',
                    )}
                  >
                    {formCheck.result.found ? (
                      <>
                        <CheckCircle2 className="size-3.5 shrink-0" />
                        <span className="min-w-0 truncate" title={formCheck.result.path ?? ''}>
                          已找到:{formCheck.result.path}
                        </span>
                      </>
                    ) : (
                      <>
                        <XCircle className="size-3.5 shrink-0" />
                        PATH 中未找到该命令,保存前请先安装
                      </>
                    )}
                  </p>
                )}
                {formCheck.error && (
                  <p className="mt-1.5 text-xs text-destructive">{formCheck.error}</p>
                )}
              </div>

              <div>
                <label className={LABEL_CLS}>参数(可选)</label>
                <input
                  className={cn(INPUT_CLS, 'font-mono')}
                  placeholder="--stdio"
                  value={draft.args}
                  onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                />
                <p className="mt-1.5 text-xs text-foreground-subtlest">
                  按空格分隔,含空白的参数用引号包裹,如 <code>--config "a b.json"</code>。
                </p>
              </div>

              <div className="flex min-h-0 flex-1 flex-col">
                <label className={LABEL_CLS}>环境变量(可选)</label>
                <textarea
                  className="min-h-[100px] w-full flex-1 resize-y rounded-lg border border-border bg-surface-hover px-3 py-2.5 font-mono text-[13px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-ring/60 focus:ring-1 focus:ring-ring/40 lg:min-h-[140px]"
                  placeholder={'RUST_BACKTRACE=1\nNODE_OPTIONS=--max-old-space-size=4096'}
                  value={draft.env}
                  onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                />
                <p className="mt-1.5 text-xs text-foreground-subtlest">
                  每行一条 <code>KEY=VALUE</code>,# 开头的行忽略;启动 server 子进程时注入。
                </p>
              </div>

              {err && (
                <div className="rounded-lg bg-red-500/10 px-3 py-2.5 text-[13px] text-red-600 dark:text-red-400">
                  {err}
                </div>
              )}
            </section>

            {/* 右栏:能力说明 */}
            <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface-hover/30 p-6">
              <h3 className="text-[13px] font-medium text-foreground-subtle">agent 获得的工具</h3>

              <div className="flex flex-col gap-2">
                {AGENT_TOOLS.map((t) => (
                  <div
                    key={t}
                    className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-surface-hover/40 px-4 py-2.5"
                  >
                    <FileCode2 className="size-4 shrink-0 text-brand" />
                    <span className="font-mono text-[13px] text-foreground">{t}</span>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border border-border/60 bg-surface-hover/40 p-4 text-xs leading-relaxed text-foreground-subtlest">
                配置任意 LSP server 后,agent 在新任务中自动获得以上代码导航工具;
                按文件扩展名自动路由到对应语言的 server(无需手动选择)。server
                为懒启动,首次调用对应语言工具时拉起并复用整个会话。
              </div>
            </section>
          </div>

          {/* 底部操作条:吸附在内容区可视底部,随滚动贴底 */}
          <div className="sticky bottom-0 z-10 -mx-6 mt-auto border-t border-border bg-background/95 px-6 py-3 backdrop-blur md:-mx-10 md:px-10">
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="lg" onClick={() => setView({ kind: 'list' })}>
                取消
              </Button>
              <Button size="lg" onClick={handleSubmit} disabled={busy}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </ViewScroll>
  );
}
