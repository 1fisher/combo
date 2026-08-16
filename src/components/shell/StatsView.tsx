import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Coins, Cpu, Loader2, TrendingUp, Wallet } from 'lucide-react';
import { getUsageStats, type UsageStats as UsageStatsData } from '../../lib/api';
import { cn } from '../../lib/utils';
import { HeroEmpty, PAGE, PageHeader, ViewScroll } from './PageShell';

/**
 * 用量统计视图(主内容区独立视图,按自动化视图的设计思路):
 * 无数据时 hero 空首页;有数据时全宽统计页——概览卡片行 + 趋势图表双栏 +
 * 模型分布(饼图 + 明细表)+ 请求次数柱状图,时间范围分段控件置于页头。
 */

const PIE_COLORS = [
  '#4C7DFF',
  '#7C3AED',
  '#10B981',
  '#F59E0B',
  '#EF4444',
  '#6B7280',
  '#EC4899',
  '#14B8A6',
];

type RangeKey = 'today' | '7d' | '30d';

const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: 'today', label: '今天', days: 1 },
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '30d', label: '近 30 天', days: 30 },
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

const TOOLTIP_STYLE = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
};

const AXIS_TICK = { fontSize: 10, fill: 'var(--foreground-subtlest)' };

export function StatsView() {
  const { data, isLoading } = useQuery<UsageStatsData>({
    queryKey: ['usage-stats'],
    queryFn: getUsageStats,
  });
  const [range, setRange] = useState<RangeKey>('7d');

  const dailyFiltered = useMemo(() => {
    if (!data) return [];
    const today = new Date().toISOString().slice(0, 10);
    const days = RANGES.find((r) => r.key === range)?.days ?? 7;
    return data.daily.filter((d) => {
      const diff = Math.floor(
        (new Date(today).getTime() - new Date(d.date).getTime()) / 86_400_000
      );
      return diff >= 0 && diff < days;
    });
  }, [data, range]);

  const rangeStats = useMemo(
    () =>
      dailyFiltered.reduce(
        (acc, d) => ({
          tokens: acc.tokens + d.prompt_tokens + d.completion_tokens,
          cost: acc.cost + d.cost,
          requests: acc.requests + d.request_count,
        }),
        { tokens: 0, cost: 0, requests: 0 }
      ),
    [dailyFiltered]
  );

  const chartData = useMemo(
    () =>
      dailyFiltered.map((d) => ({
        date: d.date.slice(5),
        tokens: d.prompt_tokens + d.completion_tokens,
        cost: Number(d.cost.toFixed(4)),
        requests: d.request_count,
      })),
    [dailyFiltered]
  );

  const modelPieData = useMemo(
    () =>
      (data?.by_model ?? [])
        .filter((m) => m.prompt_tokens + m.completion_tokens > 0)
        .map((m) => ({
          name: m.model,
          value: m.prompt_tokens + m.completion_tokens,
          cost: m.cost,
        })),
    [data]
  );

  const rangeLabel = RANGES.find((r) => r.key === range)?.label ?? '';
  const hasData = !!data && (data.daily.length > 0 || (data.by_model ?? []).length > 0);

  if (isLoading) {
    return (
      <ViewScroll>
        <div className={cn(PAGE)}>
          <div className="flex items-center justify-center gap-2 py-24 text-[13px] text-foreground-subtle">
            <Loader2 className="size-4 animate-spin" /> 加载中…
          </div>
        </div>
      </ViewScroll>
    );
  }

  if (!hasData) {
    return (
      <ViewScroll>
        <HeroEmpty
          title="还没有用量数据"
          desc="发起一次对话后,这里会展示 token 消耗、费用与模型分布,帮你掌握每个项目的用量趋势。"
        >
          <p className="relative z-10 mt-5 max-w-md px-4 text-center text-xs leading-relaxed text-foreground-subtlest">
            用量按 provider 上报的真实 token 计数累计,不含估算。
          </p>
        </HeroEmpty>
      </ViewScroll>
    );
  }

  return (
    <ViewScroll>
      <div className={cn(PAGE, 'gap-6')}>
        <PageHeader
          title="用量统计"
          desc="token 消耗与费用,按模型与时间段分析用量趋势;数据来自 provider 上报的真实用量。"
        >
          {/* 时间范围分段控件 */}
          <div className="grid h-9 w-fit grid-cols-3 gap-1 rounded-lg bg-surface p-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className={cn(
                  'flex h-7 items-center justify-center rounded-md px-3 text-[13px] transition-colors',
                  range === r.key
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-foreground-subtle hover:text-foreground'
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </PageHeader>

        {/* 概览卡片 */}
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <div className="rounded-xl border border-border bg-surface-hover/30 p-5">
            <div className="flex items-center gap-1.5 text-foreground-subtlest">
              <Cpu className="size-3.5" />
              <span className="text-xs">Tokens({rangeLabel})</span>
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
              {formatTokens(rangeStats.tokens)}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface-hover/30 p-5">
            <div className="flex items-center gap-1.5 text-foreground-subtlest">
              <Coins className="size-3.5" />
              <span className="text-xs">花费({rangeLabel})</span>
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
              {formatCost(rangeStats.cost)}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface-hover/30 p-5">
            <div className="flex items-center gap-1.5 text-foreground-subtlest">
              <TrendingUp className="size-3.5" />
              <span className="text-xs">请求({rangeLabel})</span>
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
              {rangeStats.requests}
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface-hover/30 p-5">
            <div className="flex items-center gap-1.5 text-foreground-subtlest">
              <Wallet className="size-3.5" />
              <span className="text-xs">累计花费(全部)</span>
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
              {formatCost(data!.total_cost)}
            </p>
            <p className="mt-1 text-xs tabular-nums text-foreground-subtlest">
              {formatTokens(data!.total_prompt_tokens + data!.total_completion_tokens)} tokens ·{' '}
              {data!.total_requests} 次请求
            </p>
          </div>
        </div>

        {/* 趋势图表:用量 + 费用并排 */}
        {(chartData.length > 0 || modelPieData.length > 0) && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {chartData.length > 1 && (
              <section className="rounded-xl border border-border bg-surface-hover/30 p-5">
                <h3 className="mb-3 text-[13px] font-medium text-foreground">用量趋势</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={chartData} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                    <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                    <YAxis
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => formatTokens(v)}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(value) => [formatTokens(Number(value)), 'Tokens']}
                    />
                    <Line type="monotone" dataKey="tokens" stroke="#4C7DFF" strokeWidth={2} dot={{ r: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </section>
            )}
            {chartData.length > 1 && (
              <section className="rounded-xl border border-border bg-surface-hover/30 p-5">
                <h3 className="mb-3 text-[13px] font-medium text-foreground">费用趋势</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={chartData} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                    <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                    <YAxis
                      tick={AXIS_TICK}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `$${v.toFixed(2)}`}
                    />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      formatter={(value) => [formatCost(Number(value)), '花费']}
                    />
                    <Line type="monotone" dataKey="cost" stroke="#7C3AED" strokeWidth={2} dot={{ r: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </section>
            )}
          </div>
        )}

        {/* 模型用量分布:饼图 + 明细表 */}
        {modelPieData.length > 0 && (
          <section className="rounded-xl border border-border bg-surface-hover/30 p-5">
            <h3 className="mb-3 text-[13px] font-medium text-foreground">模型用量分布</h3>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={modelPieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={90}
                    innerRadius={50}
                    paddingAngle={2}
                  >
                    {modelPieData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value) => formatTokens(Number(value))}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
                </PieChart>
              </ResponsiveContainer>

              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-border text-foreground-subtlest">
                      <th className="pb-2 pr-2 text-left font-normal">模型</th>
                      <th className="pb-2 px-2 text-right font-normal">Tokens</th>
                      <th className="pb-2 px-2 text-right font-normal">请求</th>
                      <th className="pb-2 pl-2 text-right font-normal">花费</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.by_model ?? []).map((m) => (
                      <tr
                        key={`${m.provider}/${m.model}`}
                        className="border-b border-border/50"
                      >
                        <td className="py-2 pr-2">
                          <span className="truncate text-foreground">{m.model}</span>
                          <span className="ml-1.5 text-xs text-foreground-subtlest">
                            {m.provider}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums text-foreground-subtle">
                          {formatTokens(m.prompt_tokens + m.completion_tokens)}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums text-foreground-subtle">
                          {m.request_count}
                        </td>
                        <td className="py-2 pl-2 text-right font-medium tabular-nums text-foreground">
                          {formatCost(m.cost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* 请求次数 */}
        {chartData.length > 1 && (
          <section className="rounded-xl border border-border bg-surface-hover/30 p-5">
            <h3 className="mb-3 text-[13px] font-medium text-foreground">请求次数</h3>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} />
                <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="requests" fill="#10B981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </section>
        )}
      </div>
    </ViewScroll>
  );
}
