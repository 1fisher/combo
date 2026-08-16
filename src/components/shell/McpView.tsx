import { useEffect, useState } from 'react';
import {
  Cable,
  CheckCircle2,
  ChevronLeft,
  FolderOpen,
  Globe,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Webhook,
  XCircle,
} from 'lucide-react';
import { Button } from '../ui/button';
import { useMcpActions, useMcpServers } from '../../hooks/useMcp';
import { testMcpServer } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { confirmDialog } from '../../lib/confirm';
import { cn } from '../../lib/utils';
import { HeroCard, HeroEmpty, INPUT_CLS, LABEL_CLS, PAGE, PageHeader, ViewScroll } from './PageShell';

/**
 * MCP 视图(主内容区独立视图,按自动化视图的设计思路):
 * - 无 server 时 hero 首页:模板卡片(文件系统/网页抓取/自定义)直达表单并预填;
 * - 列表:全宽 server 卡片(类型图标 + 地址 + 连接测试结果 + 操作);
 * - 表单:双栏工作台(左基本信息,右连接方式选项卡)+ 吸底操作条。
 */

type McpServer = Api.McpServer;
type TestResult = Api.McpTestResult;

type Draft = {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  url: string;
};

function emptyDraft(): Draft {
  return { name: '', transport: 'stdio', command: '', url: '' };
}

function draftFrom(s: McpServer): Draft {
  return {
    name: s.name,
    transport: s.type === 'http' ? 'http' : 'stdio',
    command: s.command ?? '',
    url: s.url ?? '',
  };
}

type View = { kind: 'list' } | { kind: 'form'; editing: McpServer | null; preset?: Partial<Draft> };

/** 首页模板卡片:点击直达表单并预填 */
const TEMPLATES: { icon: typeof Cable; title: string; desc: string; preset: Partial<Draft> }[] = [
  {
    icon: FolderOpen,
    title: '文件系统',
    desc: '让 agent 读写指定目录下的文件。',
    preset: {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx -y @modelcontextprotocol/server-filesystem /tmp',
    },
  },
  {
    icon: Webhook,
    title: '网页抓取',
    desc: '让 agent 抓取并阅读网页内容。',
    preset: { name: 'fetch', transport: 'stdio', command: 'uvx mcp-server-fetch' },
  },
  {
    icon: Pencil,
    title: '自定义',
    desc: '跳过模板,手动配置连接方式。',
    preset: {},
  },
];

const TRANSPORTS: {
  value: Draft['transport'];
  label: string;
  icon: typeof Cable;
  desc: string;
}[] = [
  {
    value: 'stdio',
    label: '本地进程',
    icon: Cable,
    desc: 'combo-cli 以子进程方式拉起命令,经标准输入输出通信。',
  },
  {
    value: 'http',
    label: '远程 HTTP',
    icon: Globe,
    desc: '连接已部署的 MCP 服务端点(streamable HTTP)。',
  },
];

function TypeBadge({ type }: { type: string }) {
  const http = type === 'http';
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
        http ? 'bg-brand/10 text-brand' : 'bg-surface-hover text-foreground-subtle'
      )}
    >
      {http ? 'HTTP' : 'stdio'}
    </span>
  );
}

export function McpView() {
  const { data: servers, isLoading } = useMcpServers();
  const { upsert, upserting, remove, removing } = useMcpActions();

  const [view, setView] = useState<View>({ kind: 'list' });
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [err, setErr] = useState('');

  // 测试连接状态(name → 结果 / 错误文本)
  const [testingName, setTestingName] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});

  // 进入表单视图时初始化草稿:编辑对象优先,其次模板预设
  useEffect(() => {
    if (view.kind === 'form') {
      setDraft(
        view.editing
          ? draftFrom(view.editing)
          : { ...emptyDraft(), ...(view.preset ?? {}) }
      );
      setErr('');
    }
  }, [view]);

  async function handleSubmit() {
    const name = draft.name.trim();
    if (!name) return setErr('请填写 server 名称');
    if (draft.transport === 'stdio' && !draft.command.trim())
      return setErr('stdio 类型需要填写启动命令');
    if (draft.transport === 'http' && !draft.url.trim())
      return setErr('http 类型需要填写服务地址');
    setErr('');
    try {
      await upsert({
        name,
        type: draft.transport,
        command: draft.transport === 'stdio' ? draft.command.trim() : undefined,
        url: draft.transport === 'http' ? draft.url.trim() : undefined,
      });
      setView({ kind: 'list' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function onTest(server: McpServer) {
    setTestingName(server.name);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[server.name];
      return next;
    });
    setTestErrors((prev) => {
      const next = { ...prev };
      delete next[server.name];
      return next;
    });
    try {
      const result = await testMcpServer({
        type: server.type,
        command: server.command ?? undefined,
        url: server.url ?? undefined,
      });
      setTestResults((prev) => ({ ...prev, [server.name]: result }));
    } catch (e) {
      setTestErrors((prev) => ({
        ...prev,
        [server.name]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setTestingName(null);
    }
  }

  async function onRemove(server: McpServer) {
    if (!(await confirmDialog(`确定删除 MCP server「${server.name}」?`))) return;
    try {
      await remove(server.name);
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[server.name];
        return next;
      });
      setTestErrors((prev) => {
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
            title="为 agent 接入更多工具"
            desc="MCP(Model Context Protocol)让 agent 调用外部工具:文件系统、网页抓取、数据库……配置一次,所有任务可用。"
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
              title="MCP 工具"
              desc="配置保存到 combo-cli.toml 的 [mcp.*] 段,新任务运行时自动加载。可先「测试连接」确认配置可用。"
            >
              <Button size="lg" onClick={() => setView({ kind: 'form', editing: null })}>
                <Plus /> 添加 server
              </Button>
            </PageHeader>

            {(servers ?? []).map((server) => {
              const testing = testingName === server.name;
              const result = testResults[server.name];
              const error = testErrors[server.name];
              return (
                <div
                  key={server.name}
                  className="group flex flex-col gap-4 rounded-xl border border-border bg-surface-hover/40 px-6 py-5 transition-colors hover:bg-surface-hover md:flex-row md:items-center md:gap-6"
                >
                  {/* 类型图标 */}
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-hover">
                    {server.type === 'http' ? (
                      <Globe className="size-5 text-brand" />
                    ) : (
                      <Cable className="size-5 text-brand" />
                    )}
                  </span>

                  {/* 名称 + 地址 + 测试结果 */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {server.name}
                      </span>
                      <TypeBadge type={server.type} />
                    </div>
                    <code className="mt-1 block truncate font-mono text-[13px] text-foreground-subtlest">
                      {server.type === 'http' ? server.url : server.command}
                    </code>

                    {(result || error) && (
                      <div
                        className={cn(
                          'mt-2.5 rounded-lg border px-3 py-2',
                          error
                            ? 'border-destructive/20 bg-destructive/5'
                            : 'border-brand/20 bg-brand/5'
                        )}
                      >
                        <div className="flex items-center gap-1.5 text-[13px]">
                          {error ? (
                            <XCircle className="size-4 shrink-0 text-destructive" />
                          ) : (
                            <CheckCircle2 className="size-4 shrink-0 text-brand" />
                          )}
                          <span
                            className={cn(
                              'min-w-0 truncate',
                              error ? 'text-destructive' : 'text-foreground'
                            )}
                          >
                            {error
                              ? `连接失败:${error}`
                              : `连接成功,发现 ${result?.tool_count ?? 0} 个工具`}
                          </span>
                        </div>
                        {!error && result?.tools && result.tools.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {result.tools.map((t) => (
                              <span
                                key={t}
                                className="rounded bg-surface-hover px-1.5 py-0.5 text-xs text-foreground-subtle"
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* 操作 */}
                  <div className="flex shrink-0 items-center justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={testing || removing}
                      onClick={() => void onTest(server)}
                      title="发起一次连接测试"
                    >
                      {testing ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" /> 测试中…
                        </>
                      ) : (
                        '测试连接'
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
              共 {servers.length} 个 MCP server · 新任务运行时自动加载
            </p>
          </div>
        ))}

      {/* ---------- 表单视图(双栏工作台,同自动化表单) ---------- */}
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
                {view.editing ? '编辑 MCP server' : '添加 MCP server'}
              </h2>
              <p className="mt-0.5 text-[13px] text-foreground-subtle">
                保存后写入 combo-cli.toml,新任务运行时自动加载;可回列表「测试连接」验证。
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            {/* 左栏:基本信息 */}
            <section className="flex flex-col gap-5 rounded-xl border border-border bg-surface-hover/30 p-6">
              <h3 className="text-[13px] font-medium text-foreground-subtle">基本信息</h3>

              <div>
                <label className={LABEL_CLS}>名称</label>
                <input
                  className={INPUT_CLS}
                  placeholder="如 filesystem、github(配置段名 [mcp.<名称>])"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>

              {draft.transport === 'stdio' ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <label className={LABEL_CLS}>启动命令</label>
                  <textarea
                    className="min-h-[120px] w-full flex-1 resize-y rounded-lg border border-border bg-surface-hover px-3 py-2.5 font-mono text-[13px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-ring/60 focus:ring-1 focus:ring-ring/40 lg:min-h-[180px]"
                    placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp"
                    value={draft.command}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  />
                  <p className="mt-1.5 text-xs text-foreground-subtlest">
                    整条命令原样保存;参数含空格无需加引号,按行书写即可。
                  </p>
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <label className={LABEL_CLS}>服务地址(URL)</label>
                  <textarea
                    className="min-h-[120px] w-full flex-1 resize-y rounded-lg border border-border bg-surface-hover px-3 py-2.5 font-mono text-[13px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-ring/60 focus:ring-1 focus:ring-ring/40 lg:min-h-[180px]"
                    placeholder="http://127.0.0.1:3001/mcp"
                    value={draft.url}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  />
                  <p className="mt-1.5 text-xs text-foreground-subtlest">
                    streamable HTTP 端点;需要鉴权时把令牌拼在 URL 查询参数里。
                  </p>
                </div>
              )}

              {err && (
                <div className="rounded-lg bg-red-500/10 px-3 py-2.5 text-[13px] text-red-600 dark:text-red-400">
                  {err}
                </div>
              )}
            </section>

            {/* 右栏:连接方式(选项卡,同自动化调度设置) */}
            <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface-hover/30 p-6">
              <h3 className="text-[13px] font-medium text-foreground-subtle">连接方式</h3>

              <div className="flex flex-col gap-2">
                {TRANSPORTS.map((t) => {
                  const active = draft.transport === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setDraft({ ...draft, transport: t.value })}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
                        active
                          ? 'border-ring/60 bg-surface-hover shadow-sm'
                          : 'border-border/60 bg-surface-hover/40 hover:bg-surface-hover'
                      )}
                    >
                      <t.icon
                        className={cn(
                          'size-4 shrink-0',
                          active ? 'text-brand' : 'text-foreground-subtle'
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium text-foreground">
                          {t.label}
                        </span>
                        <span className="block truncate text-xs text-foreground-subtlest">
                          {t.value === 'stdio' ? '本地子进程 · stdio' : '远程服务 · streamable HTTP'}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full transition-colors',
                          active ? 'bg-brand' : 'bg-foreground-subtlest/40'
                        )}
                      />
                    </button>
                  );
                })}
              </div>

              <div className="rounded-lg border border-border/60 bg-surface-hover/40 p-4 text-xs leading-relaxed text-foreground-subtlest">
                {TRANSPORTS.find((t) => t.value === draft.transport)?.desc}
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
