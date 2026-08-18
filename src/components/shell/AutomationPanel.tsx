import { useEffect, useMemo, useState } from 'react';
import {
  AlarmClock,
  Calendar,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  Clock,
  Cpu,
  History,
  Loader2,
  Pencil,
  Play,
  Plus,
  Repeat,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Switch } from '../ui/switch';
import {
  useAutomationRuns,
  useAutomations,
  useCreateAutomation,
  useDeleteAutomation,
  useRunAutomation,
  useUpdateAutomation,
} from '../../hooks/useAutomations';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { useProviders } from '../../hooks/useAgentModel';
import { confirmDialog } from '../../lib/confirm';
import { cn } from '../../lib/utils';
import { HeroCard, HeroEmpty, INPUT_CLS, LABEL_CLS, PAGE, ViewScroll } from './PageShell';
import type { Api } from '../../lib/api/types';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** quarterly:季度内第几个月(1..3)对应的展示文案与绝对月份。 */
const QUARTER_MONTHS = [
  '第一个月(1/4/7/10 月)',
  '第二个月(2/5/8/11 月)',
  '第三个月(3/6/9/12 月)',
];

/** yearly:1..12 月。 */
const MONTHS = Array.from({ length: 12 }, (_, i) => `${i + 1} 月`);

/** monthly / quarterly / yearly:每月几号(1..31)。 */
const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => i + 1);

/** 下拉选择框通用样式(与表单内其他 select 一致)。 */
const SELECT_CLS =
  'h-9 w-full appearance-none rounded-lg border border-border bg-surface-hover px-3 text-sm text-foreground outline-none transition-colors focus:border-ring/60 focus:ring-1 focus:ring-ring/40';

function formatTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatInterval(secs: number): string {
  if (secs % 86400 === 0) return `每 ${secs / 86400} 天`;
  if (secs % 3600 === 0) return `每 ${secs / 3600} 小时`;
  if (secs % 60 === 0) return `每 ${secs / 60} 分钟`;
  return `每 ${secs} 秒`;
}

/** weekly:归一化星期列表(新 weekdays 数组优先,兼容旧 weekday 单值),升序去重。 */
function scheduleWeekdays(s: Api.AutomationSchedule): number[] {
  const days = (s.weekdays ?? []).filter((d) => d >= 1 && d <= 7);
  if (days.length) return [...new Set(days)].sort((a, b) => a - b);
  return [s.weekday && s.weekday >= 1 && s.weekday <= 7 ? s.weekday : 1];
}

function scheduleDesc(s: Api.AutomationSchedule): string {
  switch (s.type) {
    case 'once':
      return `一次性 · ${formatTime(s.run_at ?? null)}`;
    case 'interval':
      return formatInterval(s.every_seconds ?? 0);
    case 'daily':
      return `每天 ${s.time ?? '—'}`;
    case 'weekly':
      return `每周${scheduleWeekdays(s)
        .map((d) => WEEKDAYS[d - 1] ?? d)
        .join('、')} ${s.time ?? '—'}`;
    case 'monthly':
      return `每月 ${s.day ?? '—'} 日 ${s.time ?? '—'}`;
    case 'quarterly':
      return `每季度第${s.month ?? 1}个月 ${s.day ?? '—'} 日 ${s.time ?? '—'}`;
    case 'yearly':
      return `每年 ${s.month ?? '—'} 月 ${s.day ?? '—'} 日 ${s.time ?? '—'}`;
    default:
      return '';
  }
}

const STATUS_MAP: Record<string, { label: string; cls: string }> = {
  success: { label: '成功', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  error: { label: '失败', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
  cancelled: { label: '已取消', cls: 'bg-foreground-subtle/10 text-foreground-subtle' },
  skipped: { label: '已跳过', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  running: { label: '运行中', cls: 'bg-sky-500/10 text-sky-600 dark:text-sky-400' },
};

function StatusBadge({ status }: { status: string | null | undefined }) {
  const s = STATUS_MAP[status ?? ''];
  if (!s) return null;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
        s.cls
      )}
    >
      {s.label}
    </span>
  );
}

/** 思考强度选项(与 Composer 一致)。 */
const THOUGHT_LEVELS = [
  { id: 'nothink', label: '无思考' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' },
] as const;

type ScheduleType = Api.AutomationScheduleType;

type Draft = {
  name: string;
  workspaceId: string;
  prompt: string;
  scheduleType: ScheduleType;
  /** once:datetime-local 字符串 */
  runAt: string;
  /** interval:分钟数(字符串) */
  every: string;
  /** daily / weekly / monthly / quarterly / yearly:HH:MM */
  time: string;
  /** weekly:选中的星期(1..7,升序;可多选) */
  weekdays: number[];
  /** monthly / quarterly / yearly:每月几号(1..31) */
  day: string;
  /** quarterly:季度内第几个月(1..3);yearly:几月(1..12) */
  month: string;
  /** 单独使用的模型:providerId+modelId 同时非空才生效,否则跟随项目默认 */
  providerId: string;
  modelId: string;
  /** 思考强度(nothink / high / max) */
  reasoningEffort: string;
};

function toDatetimeLocal(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(v: string): number {
  return Math.floor(new Date(v).getTime() / 1000);
}

function emptyDraft(): Draft {
  return {
    name: '',
    workspaceId: '',
    prompt: '',
    scheduleType: 'daily',
    runAt: '',
    every: '60',
    time: '09:00',
    weekdays: [1],
    day: '1',
    month: '1',
    providerId: '',
    modelId: '',
    reasoningEffort: 'high',
  };
}

function draftFromAutomation(a: Api.Automation): Draft {
  return {
    name: a.name,
    workspaceId: a.workspace_id,
    prompt: a.prompt,
    scheduleType: a.schedule.type,
    runAt: a.schedule.run_at ? toDatetimeLocal(a.schedule.run_at) : '',
    every: String(Math.max(1, Math.round((a.schedule.every_seconds ?? 3600) / 60))),
    time: a.schedule.time ?? '09:00',
    weekdays: scheduleWeekdays(a.schedule),
    day: String(a.schedule.day ?? 1),
    month: String(a.schedule.month ?? 1),
    providerId: a.model?.provider ?? '',
    modelId: a.model?.model ?? '',
    reasoningEffort: a.model?.reasoning_effort ?? 'high',
  };
}

type View =
  | { kind: 'list' }
  | { kind: 'form'; editing: Api.Automation | null; preset?: Partial<Draft> }
  | { kind: 'runs'; automation: Api.Automation };

const SCHEDULE_OPTIONS: {
  value: ScheduleType;
  label: string;
  desc: string;
  icon: typeof Clock;
}[] = [
  { value: 'once', label: '一次性', desc: '到达指定时间后运行一次', icon: AlarmClock },
  { value: 'interval', label: '固定间隔', desc: '从现在起按固定间隔重复运行', icon: Repeat },
  { value: 'daily', label: '每天', desc: '每天在固定时间运行', icon: Clock },
  { value: 'weekly', label: '每周', desc: '每周在指定日子的固定时间运行', icon: CalendarClock },
  { value: 'monthly', label: '每月', desc: '每月在指定日子的固定时间运行', icon: CalendarDays },
  { value: 'quarterly', label: '每季度', desc: '每季度在指定月份与日子的固定时间运行', icon: CalendarRange },
  { value: 'yearly', label: '每年', desc: '每年在指定日期的固定时间运行', icon: Calendar },
];

/** 首页模板卡片(与会话首页任务模板同构):点击直接进入表单并预填 */
const AUTOMATION_TEMPLATES: {
  icon: typeof Clock;
  title: string;
  desc: string;
  preset: Partial<Draft>;
}[] = [
  {
    icon: CalendarClock,
    title: '每周站会摘要',
    desc: '每周五 17:00 汇总本周 Git 提交,生成站会摘要。',
    preset: {
      name: '每周站会摘要',
      prompt:
        '请查看这个项目最近的 Git 提交记录,生成一份本周的站会摘要,包含亮点、风险与下一步计划。',
      scheduleType: 'weekly',
      weekdays: [5],
      time: '17:00',
    },
  },
  {
    icon: Zap,
    title: '每日 CI 体检',
    desc: '每天 09:00 汇总 CI 失败与不稳定测试,分析原因。',
    preset: {
      name: '每日 CI 体检',
      prompt: '请查看项目的 CI 配置与最近运行结果,汇总失败和不稳定的测试,并分析可能原因。',
      scheduleType: 'daily',
      time: '09:00',
    },
  },
  {
    icon: Pencil,
    title: '自定义任务',
    desc: '跳过模板,自行配置提示词与调度方式。',
    preset: {},
  },
];

export function AutomationPanel() {
  const { data: automations, isLoading } = useAutomations();
  const { workspaces } = useWorkspaces();
  const create = useCreateAutomation();
  const update = useUpdateAutomation();
  const remove = useDeleteAutomation();
  const run = useRunAutomation();

  const [view, setView] = useState<View>({ kind: 'list' });
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [err, setErr] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null);

  // 表单中的模型选择:provider 列表按目标项目解析(编辑态取任务绑定的项目)
  const formWsId =
    view.kind === 'form' ? draft.workspaceId || view.editing?.workspace_id || null : null;
  const { data: providers } = useProviders(formWsId);

  // 扁平化 provider → 模型,作为「单独指定模型」下拉的可选项
  const modelOptions = useMemo(() => {
    if (!providers) return [];
    const out: { value: string; label: string }[] = [];
    for (const p of providers) {
      const pName = p.name ?? p.id;
      const models = Array.isArray(p.models) ? p.models : [];
      for (const m of models) {
        const mid = m.id;
        if (!mid) continue;
        out.push({ value: `${p.id}::${mid}`, label: `${m.name ?? mid} · ${pName}` });
      }
    }
    return out;
  }, [providers]);

  // 进入表单视图时初始化草稿:编辑对象优先,其次模板预设,最后空草稿
  useEffect(() => {
    if (view.kind === 'form') {
      setDraft(
        view.editing
          ? draftFromAutomation(view.editing)
          : { ...emptyDraft(), ...(view.preset ?? {}) }
      );
      setErr('');
    }
  }, [view]);

  const busy = create.isPending || update.isPending;

  function buildSchedule(d: Draft): Api.AutomationSchedule | null {
    switch (d.scheduleType) {
      case 'once': {
        const ts = fromDatetimeLocal(d.runAt);
        if (!Number.isFinite(ts)) return null;
        return { type: 'once', run_at: ts };
      }
      case 'interval': {
        const mins = parseInt(d.every, 10);
        if (!Number.isFinite(mins) || mins <= 0) return null;
        return { type: 'interval', every_seconds: mins * 60 };
      }
      case 'daily':
        return { type: 'daily', time: d.time || '09:00' };
      case 'weekly': {
        const days = [...new Set(draft.weekdays)].sort((a, b) => a - b);
        if (!days.length) return null;
        return { type: 'weekly', weekdays: days, time: draft.time || '09:00' };
      }
      case 'monthly': {
        const day = parseInt(d.day, 10);
        if (!Number.isFinite(day) || day < 1 || day > 31) return null;
        return { type: 'monthly', day, time: d.time || '09:00' };
      }
      case 'quarterly': {
        const day = parseInt(d.day, 10);
        const month = parseInt(d.month, 10);
        if (!Number.isFinite(day) || day < 1 || day > 31) return null;
        if (!Number.isFinite(month) || month < 1 || month > 3) return null;
        return { type: 'quarterly', month, day, time: d.time || '09:00' };
      }
      case 'yearly': {
        const day = parseInt(d.day, 10);
        const month = parseInt(d.month, 10);
        if (!Number.isFinite(day) || day < 1 || day > 31) return null;
        if (!Number.isFinite(month) || month < 1 || month > 12) return null;
        return { type: 'yearly', month, day, time: d.time || '09:00' };
      }
    }
  }

  async function handleSubmit() {
    const name = draft.name.trim();
    const prompt = draft.prompt.trim();
    if (!name) return setErr('请填写任务名称');
    if (!prompt) return setErr('请填写任务提示词(agent 执行的内容)');
    if (!draft.workspaceId) return setErr('请选择目标项目');
    const schedule = buildSchedule(draft);
    if (!schedule) return setErr('请检查调度设置(一次性任务需选择未来时间,每周任务需勾选至少一个星期)');
    // 单独指定模型:providerId 与 modelId 都选上才生效,否则跟随项目默认(null 清除)
    const model =
      draft.providerId && draft.modelId
        ? {
            provider: draft.providerId,
            model: draft.modelId,
            reasoning_effort: draft.reasoningEffort || undefined,
          }
        : null;
    setErr('');
    try {
      if (view.kind === 'form' && view.editing) {
        await update.mutateAsync({
          id: view.editing.id,
          input: {
            name,
            workspace_id: draft.workspaceId,
            prompt,
            schedule,
            enabled: view.editing.enabled,
            model,
          },
        });
      } else {
        await create.mutateAsync({
          name,
          workspace_id: draft.workspaceId,
          prompt,
          schedule,
          model,
        });
      }
      setView({ kind: 'list' });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '保存失败,请重试');
    }
  }

  async function handleDelete(a: Api.Automation) {
    if (!(await confirmDialog(`确定删除自动化任务「${a.name}」吗?其运行历史也会一并删除。`))) {
      return;
    }
    await remove.mutateAsync(a.id);
  }

  async function handleRun(a: Api.Automation) {
    setRunningId(a.id);
    try {
      await run.mutateAsync(a.id);
    } finally {
      setRunningId(null);
    }
  }

  return (
    <ViewScroll>
      {/* ---------- 列表视图:加载中 / 空首页(hero)/ 任务列表 ---------- */}
        {view.kind === 'list' &&
          (isLoading ? (
            <div className={cn(PAGE)}>
              <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-foreground-subtle">
                <Loader2 className="size-4 animate-spin" /> 加载中…
              </div>
            </div>
          ) : !automations || automations.length === 0 ? (
            <HeroEmpty
              title="把重复交给 Combo,让时间为你值守"
              desc="创建定时任务,到点自动在目标项目运行 agent,结果写入会话,无需值守。"
            >
              {!workspaces?.length && (
                <p className="relative z-10 flex items-center gap-1.5 px-4 text-[13px] text-amber-600 dark:text-amber-400">
                  <CalendarClock className="size-4 shrink-0" />
                  还没有项目,请先在左侧添加项目后再创建自动化任务
                </p>
              )}
              {/* 模板卡片:点击进入表单并预填 */}
              <div className="relative z-10 mt-6 grid w-full max-w-2xl grid-cols-1 gap-4 px-4 sm:grid-cols-3">
                {AUTOMATION_TEMPLATES.map((t) => (
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
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-xl font-semibold text-foreground">自动化任务</h2>
                  <p className="mt-1.5 text-[13px] text-foreground-subtle">
                    在指定时间或周期内自动运行 agent,无需值守。运行结果写入对应项目的会话。
                  </p>
                </div>
                <Button
                  size="lg"
                  onClick={() => setView({ kind: 'form', editing: null })}
                  disabled={!workspaces?.length}
                  title={workspaces?.length ? '新建自动化任务' : '请先添加项目'}
                >
                  <Plus /> 新建任务
                </Button>
              </div>

              {(automations ?? []).map((a) => {
              const isRunning = runningId === a.id;
              return (
                <div
                  key={a.id}
                  className="group flex flex-col gap-4 rounded-xl border border-border bg-surface-hover/40 px-6 py-5 transition-colors hover:bg-surface-hover md:flex-row md:items-center md:gap-6"
                >
                  {/* 类型图标 */}
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-hover">
                    {a.schedule.type === 'once' ? (
                      <AlarmClock className="size-5 text-brand" />
                    ) : a.schedule.type === 'interval' ? (
                      <Repeat className="size-5 text-brand" />
                    ) : a.schedule.type === 'weekly' ? (
                      <CalendarClock className="size-5 text-brand" />
                    ) : a.schedule.type === 'monthly' ? (
                      <CalendarDays className="size-5 text-brand" />
                    ) : a.schedule.type === 'quarterly' ? (
                      <CalendarRange className="size-5 text-brand" />
                    ) : a.schedule.type === 'yearly' ? (
                      <Calendar className="size-5 text-brand" />
                    ) : (
                      <Clock className="size-5 text-brand" />
                    )}
                  </span>

                  {/* 任务名 + 提示词预览(占主导宽度) */}
                  <div className="min-w-0 flex-1 md:flex-[2.4]">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {a.name}
                      </span>
                      <StatusBadge status={a.last_status} />
                    </div>
                    <p className="mt-1 line-clamp-1 text-[13px] leading-relaxed text-foreground-subtlest">
                      {a.prompt}
                    </p>
                  </div>

                  {/* 项目 / 调度 */}
                  <div className="min-w-0 md:flex-1">
                    <p className="truncate text-[13px] text-foreground-subtle">
                      {a.workspace_name || '未知项目'}
                    </p>
                    <p className="mt-0.5 truncate text-[13px] text-foreground-subtlest">
                      {scheduleDesc(a.schedule)}
                    </p>
                    {a.model && (
                      <p className="mt-0.5 truncate text-[13px] text-foreground-subtlest">
                        模型: {a.model.model}
                        {a.model.reasoning_effort ? ` · ${a.model.reasoning_effort}` : ''}
                      </p>
                    )}
                  </div>

                  {/* 运行状态:标签 + 时间分两行,时间超长换行而非截断 */}
                  <div className="min-w-0 md:flex-1">
                    {a.enabled ? (
                      a.schedule.type === 'once' && !a.next_run_at ? (
                        <p className="text-[13px] text-foreground-subtle">已执行完成</p>
                      ) : (
                        <>
                          <p className="text-[13px] text-foreground-subtle">下次运行</p>
                          <p className="mt-0.5 break-words text-[13px] leading-snug text-foreground-subtle">
                            {formatTime(a.next_run_at)}
                          </p>
                        </>
                      )
                    ) : (
                      <p className="text-[13px] text-foreground-subtle">已暂停</p>
                    )}
                    {a.last_run_at && (
                      <p className="mt-0.5 break-words text-[13px] leading-snug text-foreground-subtlest">
                        上次: {formatTime(a.last_run_at)}
                      </p>
                    )}
                  </div>

                  {/* 操作 + 开关 */}
                  <div className="flex shrink-0 items-center justify-between gap-1 md:justify-end">
                    <div className="flex items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="立即运行"
                        disabled={isRunning}
                        onClick={() => handleRun(a)}
                      >
                        {isRunning ? <Loader2 className="size-4 animate-spin" /> : <Play />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="运行历史"
                        onClick={() => setView({ kind: 'runs', automation: a })}
                      >
                        <History />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="编辑"
                        onClick={() => setView({ kind: 'form', editing: a })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="删除"
                        onClick={() => handleDelete(a)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <Switch
                      checked={a.enabled}
                      aria-label="启用/暂停"
                      onCheckedChange={(v) =>
                        update.mutate({ id: a.id, input: { enabled: v } })
                      }
                    />
                  </div>
                </div>
              );
            })}

              <p className="px-1 text-[13px] text-foreground-subtlest">
                共 {automations.length} 个任务 · 运行结果写入对应项目的会话,可在会话列表中查看
              </p>
            </div>
          ))}

        {/* ---------- 表单视图 ---------- */}
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
                  {view.editing ? '编辑自动化任务' : '新建自动化任务'}
                </h2>
                <p className="mt-0.5 text-[13px] text-foreground-subtle">
                  任务会按设定的调度自动运行 agent,结果写入目标项目的会话。
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              {/* 左栏:基本信息 */}
              <section className="flex flex-col gap-5 rounded-xl border border-border bg-surface-hover/30 p-6">
                <h3 className="text-[13px] font-medium text-foreground-subtle">基本信息</h3>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <div>
                    <label className={LABEL_CLS}>
                      任务名称
                    </label>
                    <input
                      className="h-9 w-full rounded-lg border border-border bg-surface-hover px-3 text-sm text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-ring/60 focus:ring-1 focus:ring-ring/40"
                      placeholder="如:每周五生成站会摘要"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className={LABEL_CLS}>
                      目标项目
                    </label>
                    <select
                      className="h-9 w-full appearance-none rounded-lg border border-border bg-surface-hover px-3 text-sm text-foreground outline-none transition-colors focus:border-ring/60 focus:ring-1 focus:ring-ring/40"
                      value={draft.workspaceId}
                      onChange={(e) => setDraft({ ...draft, workspaceId: e.target.value })}
                    >
                      <option value="" disabled>
                        {workspaces?.length ? '选择项目' : '暂无项目,请先在左侧添加'}
                      </option>
                      {(workspaces ?? []).map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex min-h-0 flex-1 flex-col">
                  <label className={LABEL_CLS}>
                    任务提示词
                  </label>
                  <textarea
                    className="min-h-[180px] w-full flex-1 resize-y rounded-lg border border-border bg-surface-hover px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none transition-colors placeholder:text-foreground-subtlest focus:border-ring/60 focus:ring-1 focus:ring-ring/40 lg:min-h-[240px]"
                    placeholder="告诉 agent 要做什么,如:请汇总本周 git 提交记录,生成一份中文站会摘要,包含亮点、风险与下一步计划。"
                    value={draft.prompt}
                    onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                  />
                  <p className="mt-1.5 text-xs text-foreground-subtlest">
                    每次触发都会在目标项目新建会话(标题带 ⏰ 前缀)并以此提示词发起运行。
                  </p>
                </div>
              </section>

              {/* 右栏:调度设置 */}
              <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface-hover/30 p-6">
                <h3 className="text-[13px] font-medium text-foreground-subtle">调度设置</h3>

                <div className="flex flex-col gap-2">
                  {SCHEDULE_OPTIONS.map((t) => {
                    const active = draft.scheduleType === t.value;
                    return (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => setDraft({ ...draft, scheduleType: t.value })}
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
                            {t.desc}
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

                <div className="rounded-lg border border-border/60 bg-surface-hover/40 p-4">
                  {draft.scheduleType === 'once' && (
                    <div>
                      <label className={LABEL_CLS}>
                        执行时间
                      </label>
                      <input
                        type="datetime-local"
                        className={INPUT_CLS}
                        value={draft.runAt}
                        onChange={(e) => setDraft({ ...draft, runAt: e.target.value })}
                      />
                      <p className="mt-1.5 text-xs text-foreground-subtlest">
                        到达该时间后运行一次,之后不再触发。
                      </p>
                    </div>
                  )}
                  {draft.scheduleType === 'interval' && (
                    <div>
                      <label className={LABEL_CLS}>
                        执行间隔(分钟)
                      </label>
                      <input
                        type="number"
                        min={1}
                        className={INPUT_CLS}
                        value={draft.every}
                        onChange={(e) => setDraft({ ...draft, every: e.target.value })}
                      />
                      <p className="mt-1.5 text-xs text-foreground-subtlest">
                        {(() => {
                          const mins = parseInt(draft.every, 10);
                          return Number.isFinite(mins) && mins > 0
                            ? `即 ${formatInterval(mins * 60)}运行一次,自保存时刻起算。`
                            : '请输入大于 0 的分钟数。';
                        })()}
                      </p>
                    </div>
                  )}
                  {draft.scheduleType === 'daily' && (
                    <div>
                      <label className={LABEL_CLS}>
                        每天执行时间
                      </label>
                      <input
                        type="time"
                        className={INPUT_CLS}
                        value={draft.time}
                        onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                      />
                      <p className="mt-1.5 text-xs text-foreground-subtlest">按本机时区每天触发。</p>
                    </div>
                  )}
                  {draft.scheduleType === 'weekly' && (
                    <div>
                      <label className={LABEL_CLS}>星期(可多选)</label>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {WEEKDAYS.map((w, i) => {
                          const day = i + 1;
                          const active = draft.weekdays.includes(day);
                          return (
                            <button
                              key={w}
                              type="button"
                              aria-pressed={active}
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  weekdays: active
                                    ? draft.weekdays.filter((d) => d !== day)
                                    : [...draft.weekdays, day].sort((a, b) => a - b),
                                })
                              }
                              className={cn(
                                'h-9 min-w-[52px] rounded-lg border px-2 text-sm transition-colors',
                                active
                                  ? 'border-ring/60 bg-surface-hover font-medium text-brand shadow-sm'
                                  : 'border-border/60 bg-surface-hover/40 text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
                              )}
                            >
                              {w}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-3">
                        <label className={LABEL_CLS}>执行时间</label>
                        <input
                          type="time"
                          className={INPUT_CLS}
                          value={draft.time}
                          onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                        />
                      </div>
                      <p className="mt-1.5 text-xs text-foreground-subtlest">
                        所选的日子都会在该时间各触发一次,按本机时区执行。
                      </p>
                    </div>
                  )}
                  {draft.scheduleType === 'monthly' && (
                    <div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={LABEL_CLS}>每月几号</label>
                          <select
                            className={SELECT_CLS}
                            value={draft.day}
                            onChange={(e) => setDraft({ ...draft, day: e.target.value })}
                          >
                            {DAY_OPTIONS.map((d) => (
                              <option key={d} value={String(d)}>
                                {d} 日
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={LABEL_CLS}>执行时间</label>
                          <input
                            type="time"
                            className={INPUT_CLS}
                            value={draft.time}
                            onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                          />
                        </div>
                      </div>
                      <p className="mt-1.5 text-xs text-foreground-subtlest">
                        按本机时区每月触发;当月天数不足时取当月最后一天(如 31 日在 2 月取月末)。
                      </p>
                    </div>
                  )}
                  {draft.scheduleType === 'quarterly' && (
                    <div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={LABEL_CLS}>季度内月份</label>
                          <select
                            className={SELECT_CLS}
                            value={draft.month}
                            onChange={(e) => setDraft({ ...draft, month: e.target.value })}
                          >
                            {QUARTER_MONTHS.map((m, i) => (
                              <option key={m} value={String(i + 1)}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={LABEL_CLS}>日期</label>
                          <select
                            className={SELECT_CLS}
                            value={draft.day}
                            onChange={(e) => setDraft({ ...draft, day: e.target.value })}
                          >
                            {DAY_OPTIONS.map((d) => (
                              <option key={d} value={String(d)}>
                                {d} 日
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="mt-3">
                        <label className={LABEL_CLS}>执行时间</label>
                        <input
                          type="time"
                          className={INPUT_CLS}
                          value={draft.time}
                          onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                        />
                      </div>
                      <p className="mt-1.5 text-xs text-foreground-subtlest">
                        按本机时区每季度触发;当月天数不足时取当月最后一天。
                      </p>
                    </div>
                  )}
                  {draft.scheduleType === 'yearly' && (
                    <div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className={LABEL_CLS}>月份</label>
                          <select
                            className={SELECT_CLS}
                            value={draft.month}
                            onChange={(e) => setDraft({ ...draft, month: e.target.value })}
                          >
                            {MONTHS.map((m, i) => (
                              <option key={m} value={String(i + 1)}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={LABEL_CLS}>日期</label>
                          <select
                            className={SELECT_CLS}
                            value={draft.day}
                            onChange={(e) => setDraft({ ...draft, day: e.target.value })}
                          >
                            {DAY_OPTIONS.map((d) => (
                              <option key={d} value={String(d)}>
                                {d} 日
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="mt-3">
                        <label className={LABEL_CLS}>执行时间</label>
                        <input
                          type="time"
                          className={INPUT_CLS}
                          value={draft.time}
                          onChange={(e) => setDraft({ ...draft, time: e.target.value })}
                        />
                      </div>
                      <p className="mt-1.5 text-xs text-foreground-subtlest">
                        按本机时区每年触发;当月天数不足时取当月最后一天(如 2 月 29 日在平年取 28 日)。
                      </p>
                    </div>
                  )}
                </div>

                {err && (
                  <div className="rounded-lg bg-red-500/10 px-3 py-2.5 text-[13px] text-red-600 dark:text-red-400">
                    {err}
                  </div>
                )}
              </section>

              {/* 右栏:模型设置(单独指定,缺省跟随项目默认) */}
              <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface-hover/30 p-6">
                <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground-subtle">
                  <Cpu className="size-3.5" /> 模型设置
                </h3>
                <div>
                  <label className={LABEL_CLS}>
                    运行模型
                  </label>
                  {(() => {
                    const modelSel =
                      draft.providerId && draft.modelId
                        ? `${draft.providerId}::${draft.modelId}`
                        : '';
                    // 编辑任务保存的模型可能不在当前列表(如 provider 已删除):仍展示以便保留
                    const known = modelOptions.some((o) => o.value === modelSel);
                    const keep =
                      modelSel && !known
                        ? [{ value: modelSel, label: `${draft.modelId} · ${draft.providerId}` }]
                        : [];
                    return (
                      <select
                        className={SELECT_CLS}
                        value={modelSel}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) {
                            setDraft({ ...draft, providerId: '', modelId: '' });
                          } else {
                            const idx = v.indexOf('::');
                            setDraft({
                              ...draft,
                              providerId: v.slice(0, idx),
                              modelId: v.slice(idx + 2),
                            });
                          }
                        }}
                      >
                        <option value="">跟随项目默认</option>
                        {keep.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                        {modelOptions.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    );
                  })()}
                  <p className="mt-1.5 text-xs text-foreground-subtlest">
                    默认跟随目标项目当前使用的模型;单独指定后,该任务每次运行都使用所选模型。
                  </p>
                </div>
                {draft.providerId && draft.modelId && (
                  <div>
                    <label className={LABEL_CLS}>
                      思考强度
                    </label>
                    <select
                      className={SELECT_CLS}
                      value={draft.reasoningEffort}
                      onChange={(e) => setDraft({ ...draft, reasoningEffort: e.target.value })}
                    >
                      {THOUGHT_LEVELS.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
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
                  保存任务
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ---------- 运行历史视图 ---------- */}
        {view.kind === 'runs' && (
          <RunHistoryView automation={view.automation} onBack={() => setView({ kind: 'list' })} />
        )}
    </ViewScroll>
  );
}

function RunHistoryView({
  automation,
  onBack,
}: {
  automation: Api.Automation;
  onBack: () => void;
}) {
  const { data: runs, isLoading } = useAutomationRuns(automation.id);

  return (
    <div className={cn(PAGE, 'gap-6')}>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" title="返回列表" onClick={onBack}>
          <ChevronLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold text-foreground">{automation.name}</h2>
          <p className="mt-0.5 text-[13px] text-foreground-subtle">
            {automation.workspace_name || '未知项目'} · {scheduleDesc(automation.schedule)}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-foreground-subtle">
            <Loader2 className="size-4 animate-spin" /> 加载中…
          </div>
        )}
        {!isLoading && (!runs || runs.length === 0) && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-surface-hover">
              <History className="size-6 text-foreground-subtle" />
            </span>
            <p className="mt-3 text-sm font-medium text-foreground">暂无运行记录</p>
            <p className="mt-1 text-[13px] text-foreground-subtlest">
              点击「立即运行」或等待定时触发,运行记录会出现在这里。
            </p>
          </div>
        )}
        {(runs ?? []).map((r) => (
          <div
            key={r.id}
            className="flex items-start gap-4 rounded-xl border border-border bg-surface-hover/40 px-6 py-5"
          >
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-hover">
              {r.status === 'running' ? (
                <Loader2 className="size-4 animate-spin text-sky-500" />
              ) : r.status === 'success' ? (
                <Zap className="size-4 text-emerald-500" />
              ) : r.status === 'error' ? (
                <Zap className="size-4 text-red-500" />
              ) : (
                <Clock className="size-4 text-foreground-subtlest" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={r.status} />
                <span className="text-[13px] text-foreground-subtlest">
                  开始 {formatTime(r.started_at)}
                  {r.finished_at ? ` · 结束 ${formatTime(r.finished_at)}` : ''}
                </span>
              </div>
              {r.error && (
                <div className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-red-600 dark:text-red-400">
                  {r.error}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
