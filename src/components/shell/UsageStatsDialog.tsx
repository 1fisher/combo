import { useEffect, useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { Coins, Cpu, Loader2, TrendingUp } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { getUsageStats, type UsageStats as UsageStatsData } from '../../lib/api';

interface UsageStatsDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const PIE_COLORS = ['#4C7DFF', '#7C3AED', '#10B981', '#F59E0B', '#EF4444', '#6B7280', '#EC4899', '#14B8A6'];

type RangeKey = 'today' | '7d' | '30d';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function UsageStatsDialog({ open, onOpenChange }: UsageStatsDialogProps) {
  const [data, setData] = useState<UsageStatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<RangeKey>('7d');

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getUsageStats()
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [open]);

  const dailyFiltered = useMemo(() => {
    if (!data) return [];
    const today = new Date().toISOString().slice(0, 10);
    const days = range === 'today' ? 1 : range === '7d' ? 7 : 30;
    return data.daily.filter((d) => {
      const diff = Math.floor(
        (new Date(today).getTime() - new Date(d.date).getTime()) / 86_400_000,
      );
      return diff >= 0 && diff < days;
    });
  }, [data, range]);

  const rangeStats = useMemo(() => {
    return dailyFiltered.reduce(
      (acc, d) => ({
        tokens: acc.tokens + d.prompt_tokens + d.completion_tokens,
        cost: acc.cost + d.cost,
        requests: acc.requests + d.request_count,
      }),
      { tokens: 0, cost: 0, requests: 0 },
    );
  }, [dailyFiltered]);

  const chartData = useMemo(
    () =>
      dailyFiltered.map((d) => ({
        date: d.date.slice(5),
        tokens: d.prompt_tokens + d.completion_tokens,
        cost: Number(d.cost.toFixed(4)),
        requests: d.request_count,
      })),
    [dailyFiltered],
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
    [data],
  );

  const rangeLabel = range === 'today' ? '今天' : range === '7d' ? '近 7 天' : '近 30 天';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingUp className="size-5" />
            用量统计
          </DialogTitle>
          <DialogDescription>
            查看 token 消耗与费用,按模型和时间段分析用量趋势
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-6 animate-spin text-foreground-subtle" />
          </div>
        ) : !data ? (
          <div className="py-20 text-center text-[13px] text-foreground-subtle">
            暂无用量数据
          </div>
        ) : (
          <div className="space-y-6">
            {/* 时间范围切换 */}
            <div className="flex gap-1 rounded-lg bg-surface-hover p-1">
              {(['today', '7d', '30d'] as RangeKey[]).map((k) => (
                <button
                  key={k}
                  className={`flex-1 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
                    range === k
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-foreground-subtle hover:text-foreground'
                  }`}
                  onClick={() => setRange(k)}
                >
                  {k === 'today' ? '今天' : k === '7d' ? '7 天' : '30 天'}
                </button>
              ))}
            </div>

            {/* 概览卡片 */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-center gap-1.5 text-foreground-subtlest">
                  <Cpu className="size-3.5" />
                  <span className="text-[11px]">Tokens({rangeLabel})</span>
                </div>
                <p className="mt-1.5 text-lg font-semibold tabular-nums text-foreground">
                  {formatTokens(rangeStats.tokens)}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-center gap-1.5 text-foreground-subtlest">
                  <Coins className="size-3.5" />
                  <span className="text-[11px]">花费({rangeLabel})</span>
                </div>
                <p className="mt-1.5 text-lg font-semibold tabular-nums text-foreground">
                  {formatCost(rangeStats.cost)}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-center gap-1.5 text-foreground-subtlest">
                  <TrendingUp className="size-3.5" />
                  <span className="text-[11px]">请求({rangeLabel})</span>
                </div>
                <p className="mt-1.5 text-lg font-semibold tabular-nums text-foreground">
                  {rangeStats.requests}
                </p>
              </div>
            </div>

            {/* 全部总计 */}
            <div className="flex items-center justify-between rounded-lg bg-surface-hover px-4 py-2.5">
              <span className="text-[12px] text-foreground-subtle">全部累计(30 天)</span>
              <div className="flex gap-4 text-[12px] tabular-nums">
                <span className="text-foreground-subtle">
                  {formatTokens(data.total_prompt_tokens + data.total_completion_tokens)} tokens
                </span>
                <span className="font-medium text-foreground">
                  {formatCost(data.total_cost)}
                </span>
              </div>
            </div>

            {/* 用量趋势曲线 */}
            {chartData.length > 1 && (
              <div>
                <h4 className="mb-2 text-[13px] font-medium text-foreground">
                  用量趋势
                </h4>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={chartData} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: 'var(--foreground-subtlest)' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'var(--foreground-subtlest)' }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => formatTokens(v)}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--popover)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(value, name) => [
                        name === 'cost' ? formatCost(Number(value)) : formatTokens(Number(value)),
                        name === 'cost' ? '花费' : 'Tokens',
                      ]}
                    />
                    <Line
                      type="monotone"
                      dataKey="tokens"
                      stroke="#4C7DFF"
                      strokeWidth={2}
                      dot={{ r: 2 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* 费用趋势曲线 */}
            {chartData.length > 1 && (
              <div>
                <h4 className="mb-2 text-[13px] font-medium text-foreground">
                  费用趋势
                </h4>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={chartData} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: 'var(--foreground-subtlest)' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'var(--foreground-subtlest)' }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => `$${v.toFixed(2)}`}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--popover)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(value) => [formatCost(Number(value)), '花费']}
                    />
                    <Line
                      type="monotone"
                      dataKey="cost"
                      stroke="#7C3AED"
                      strokeWidth={2}
                      dot={{ r: 2 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* 模型用量分布饼图 + 表格 */}
            {modelPieData.length > 0 && (
              <div>
                <h4 className="mb-2 text-[13px] font-medium text-foreground">
                  模型用量分布
                </h4>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie
                        data={modelPieData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={70}
                        innerRadius={35}
                        paddingAngle={2}
                      >
                        {modelPieData.map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: 'var(--popover)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={(value) => formatTokens(Number(value))}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 10 }}
                        iconSize={8}
                      />
                    </PieChart>
                  </ResponsiveContainer>

                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="border-b border-border text-foreground-subtlest">
                          <th className="pb-1.5 pr-2 text-left font-normal">模型</th>
                          <th className="pb-1.5 px-2 text-right font-normal">Tokens</th>
                          <th className="pb-1.5 px-2 text-right font-normal">请求</th>
                          <th className="pb-1.5 pl-2 text-right font-normal">花费</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data.by_model ?? []).map((m) => (
                          <tr key={`${m.provider}/${m.model}`} className="border-b border-border/50">
                            <td className="py-1.5 pr-2">
                              <span className="truncate text-foreground">{m.model}</span>
                              <span className="ml-1 text-[10px] text-foreground-subtlest">
                                {m.provider}
                              </span>
                            </td>
                            <td className="py-1.5 px-2 text-right tabular-nums text-foreground-subtle">
                              {formatTokens(m.prompt_tokens + m.completion_tokens)}
                            </td>
                            <td className="py-1.5 px-2 text-right tabular-nums text-foreground-subtle">
                              {m.request_count}
                            </td>
                            <td className="py-1.5 pl-2 text-right tabular-nums font-medium text-foreground">
                              {formatCost(m.cost)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* 请求次数柱状图 */}
            {chartData.length > 1 && (
              <div>
                <h4 className="mb-2 text-[13px] font-medium text-foreground">
                  请求次数
                </h4>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={chartData} margin={{ top: 5, right: 10, bottom: 0, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.3} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: 'var(--foreground-subtlest)' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'var(--foreground-subtlest)' }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--popover)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="requests" fill="#10B981" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
