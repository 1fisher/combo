import { useState } from 'react';
import {
  Boxes,
  Cable,
  CheckCircle2,
  Globe,
  Loader2,
  Plus,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { useMcpActions, useMcpServers } from '../../hooks/useMcp';
import { testMcpServer } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { confirmDialog } from '../../lib/confirm';
import { cn } from '../../lib/utils';

type McpServer = Api.McpServer;
type TestResult = Api.McpTestResult;

const inputCls =
  'h-7 w-full rounded-lg border border-input-border bg-input px-2 text-[12px] text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused';

function TypeBadge({ type }: { type: string }) {
  const http = type === 'http';
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
        http ? 'bg-brand/10 text-brand' : 'bg-surface-hover text-foreground-subtle'
      )}
    >
      {http ? 'HTTP' : 'stdio'}
    </span>
  );
}

export function McpPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data: servers, isLoading } = useMcpServers();
  const { upsert, upserting, remove, removing } = useMcpActions();

  const [filter, setFilter] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  // 新增表单
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // 测试连接状态(name → 结果 / 错误文本)
  const [testingName, setTestingName] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});

  const filtered = (servers ?? []).filter(
    (s) =>
      s.name.toLowerCase().includes(filter.toLowerCase()) ||
      (s.command ?? '').toLowerCase().includes(filter.toLowerCase()) ||
      (s.url ?? '').toLowerCase().includes(filter.toLowerCase())
  );

  function resetForm() {
    setName('');
    setTransport('stdio');
    setCommand('');
    setUrl('');
    setFormError(null);
  }

  async function onSubmit() {
    setFormError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError('请填写 server 名称');
      return;
    }
    if (transport === 'stdio' && !command.trim()) {
      setFormError('stdio 类型需要填写启动命令');
      return;
    }
    if (transport === 'http' && !url.trim()) {
      setFormError('http 类型需要填写 URL');
      return;
    }
    try {
      await upsert({
        name: trimmedName,
        type: transport,
        command: transport === 'stdio' ? command.trim() : undefined,
        url: transport === 'http' ? url.trim() : undefined,
      });
      resetForm();
      setShowAdd(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onTest(server: McpServer) {
    setTestingName(server.name);
    // 清除上次结果,避免测试进行中展示旧数据
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
    const ok = await confirmDialog(`确定删除 MCP server「${server.name}」?`);
    if (!ok) return;
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <Boxes className="size-4 text-brand" />
            MCP 工具
          </DialogTitle>
        </DialogHeader>

        {/* 搜索栏 + 添加/收起按钮 */}
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-surface-hover px-2.5 py-1.5">
            <Search className="size-3.5 shrink-0 text-foreground-subtlest" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索 MCP server…"
              className="w-full bg-transparent text-[13px] outline-none placeholder:text-foreground-subtlest"
            />
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0"
            onClick={() => {
              setShowAdd((v) => !v);
              resetForm();
            }}
          >
            <Plus className="size-3.5" />
            {showAdd ? '收起' : '添加'}
          </Button>
        </div>

        {/* 新增表单 */}
        {showAdd && (
          <div className="flex flex-col gap-2 border-b px-4 py-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="名称(如 filesystem、github)"
              className={inputCls}
            />
            {/* 传输类型切换 */}
            <div className="flex items-center gap-1">
              {(['stdio', 'http'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTransport(t)}
                  className={cn(
                    'inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-[12px] transition-colors',
                    transport === t
                      ? 'bg-brand/10 font-medium text-brand'
                      : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
                  )}
                >
                  {t === 'stdio' ? (
                    <Cable className="size-3.5" />
                  ) : (
                    <Globe className="size-3.5" />
                  )}
                  {t === 'stdio' ? '本地进程 (stdio)' : '远程 HTTP'}
                </button>
              ))}
            </div>
            {transport === 'stdio' ? (
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="启动命令,如 npx -y @modelcontextprotocol/server-filesystem /tmp"
                className={inputCls}
              />
            ) : (
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="MCP 服务地址,如 http://127.0.0.1:3001/mcp"
                className={inputCls}
              />
            )}
            {formError && (
              <div className="text-[12px] text-destructive">{formError}</div>
            )}
            <div className="flex items-center justify-end gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  resetForm();
                  setShowAdd(false);
                }}
              >
                取消
              </Button>
              <Button size="sm" onClick={onSubmit} disabled={upserting}>
                {upserting && <Loader2 className="size-3.5 animate-spin" />}
                保存
              </Button>
            </div>
          </div>
        )}

        {/* server 列表 */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {isLoading && (
            <div className="px-2.5 py-4 text-center text-[13px] text-foreground-subtle">
              加载中…
            </div>
          )}
          {!isLoading && filtered.length === 0 && (
            <div className="px-2.5 py-4 text-center text-[13px] text-foreground-subtle">
              {servers?.length === 0
                ? '还没有 MCP server,点击「添加」配置一个。'
                : '没有匹配的 MCP server'}
            </div>
          )}
          {filtered.map((server) => {
            const testing = testingName === server.name;
            const result = testResults[server.name];
            const error = testErrors[server.name];
            return (
              <div
                key={server.name}
                className="group flex items-start gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-surface-hover"
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover">
                  {server.type === 'http' ? (
                    <Globe className="size-4 text-foreground-subtle" />
                  ) : (
                    <Cable className="size-4 text-foreground-subtle" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {server.name}
                    </span>
                    <TypeBadge type={server.type} />
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-foreground-subtle">
                    {server.type === 'http' ? server.url : server.command}
                  </div>

                  {/* 测试结果 */}
                  {(result || error) && (
                    <div
                      className={cn(
                        'mt-2 rounded-lg border px-2.5 py-1.5',
                        error
                          ? 'border-destructive/20 bg-destructive/5'
                          : 'border-brand/20 bg-brand/5'
                      )}
                    >
                      <div className="flex items-center gap-1.5 text-[12px]">
                        {error ? (
                          <XCircle className="size-3.5 text-destructive" />
                        ) : (
                          <CheckCircle2 className="size-3.5 text-brand" />
                        )}
                        <span className={error ? 'text-destructive' : 'text-foreground'}>
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
                              className="rounded bg-surface-hover px-1.5 py-0.5 text-[11px] text-foreground-subtle"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 操作按钮 */}
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={testing || removing}
                    onClick={() => void onTest(server)}
                    className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-foreground-subtle hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                    title="测试连接"
                  >
                    {testing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <span>测试</span>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={removing}
                    onClick={() => void onRemove(server)}
                    className="inline-flex shrink-0 items-center rounded p-1 text-foreground-subtlest hover:bg-surface-hover hover:text-destructive disabled:opacity-50"
                    title="删除"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* 底部状态 */}
        <div className="border-t px-4 py-2 text-[12px] text-foreground-subtlest">
          共 {servers?.length ?? 0} 个 MCP server · 配置保存在 combo-cli.toml 的 [mcp.*] 段
        </div>
      </DialogContent>
    </Dialog>
  );
}
