import { useEffect, useMemo, useState } from 'react';
import { getGitLog } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

interface Props {
  workspaceId: string;
}

interface GraphCommit extends Api.GitCommitInfo {
  /** 在 graph 中的 lane 索引(0=最左) */
  lane: number;
  /** 父提交在 graph 中的 lane */
  parentLanes: number[];
}

/** 颜色调色板:不同 lane 用不同颜色 */
const LANE_COLORS = [
  '#e06c75', // 红
  '#61afef', // 蓝
  '#98c379', // 绿
  '#e5c07b', // 黄
  '#c678dd', // 紫
  '#56b6c2', // 青
  '#d19a66', // 橙
  '#ff6b9d', // 粉
];

const DOT_SIZE = 12;
const DOT_R = DOT_SIZE / 2;
const ROW_H = 36;
const LANE_W = 22;
const GRAPH_PAD = 4;

/**
 * 为提交列表分配 lane 索引,计算图布局。
 * 每个 commit 占一个 lane;其父提交继承当前 lane(若父提交有多个子则分配新 lane)。
 */
function computeLanes(commits: Api.GitCommitInfo[]): Map<string, GraphCommit> {
  const result = new Map<string, GraphCommit>();
  if (!commits || commits.length === 0) return result;

  // lane -> 当前持有该 lane 的 commit hash
  const activeLanes: (string | null)[] = [];
  const hashToLane = new Map<string, number>();

  for (const commit of commits) {
    const parents = commit.parents ?? [];
    // 找到该 commit 应进入的 lane:如果已被某 lane 预分配(作为父提交),用那个
    let lane = hashToLane.get(commit.hash);
    if (lane === undefined) {
      // 找一个空 lane
      lane = activeLanes.findIndex((l) => l === null);
      if (lane === -1) {
        lane = activeLanes.length;
        activeLanes.push(commit.hash);
      } else {
        activeLanes[lane] = commit.hash;
      }
      hashToLane.set(commit.hash, lane);
    } else {
      activeLanes[lane] = commit.hash;
    }

    // 为父提交分配 lane
    const parentLanes: number[] = [];
    for (let i = 0; i < parents.length; i++) {
      const parentHash = parents[i];
      if (i === 0) {
        // 第一个父提交继承当前 lane
        if (!hashToLane.has(parentHash)) {
          hashToLane.set(parentHash, lane);
        }
        parentLanes.push(lane);
      } else {
        // 第二个及以上父提交(merge):分配新 lane
        let pLane = hashToLane.get(parentHash);
        if (pLane === undefined) {
          pLane = activeLanes.findIndex((l) => l === null);
          if (pLane === -1) {
            pLane = activeLanes.length;
            activeLanes.push(parentHash);
          } else {
            activeLanes[pLane] = parentHash;
          }
          hashToLane.set(parentHash, pLane);
        } else if (activeLanes[pLane] !== parentHash) {
          activeLanes[pLane] = parentHash;
        }
        parentLanes.push(pLane);
      }
    }

    result.set(commit.hash, { ...commit, lane, parentLanes });
  }

  return result;
}

function branchColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_W + DOT_R;
}

function rowY(rowIndex: number): number {
  return rowIndex * ROW_H + ROW_H / 2;
}

export function GitGraph({ workspaceId }: Props) {
  const [commits, setCommits] = useState<Api.GitCommitInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getGitLog(workspaceId, 50)
      .then(({ commits }) => {
        if (!cancelled) setCommits(commits);
      })
      .catch(() => {
        if (!cancelled) setCommits([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const graphCommits = useMemo(() => computeLanes(commits), [commits]);

  const maxLane = useMemo(() => {
    let max = 0;
    for (const c of graphCommits.values()) {
      if (c.lane > max) max = c.lane;
      for (const p of c.parentLanes) {
        if (p > max) max = p;
      }
    }
    return max;
  }, [graphCommits]);

  const graphWidth = GRAPH_PAD * 2 + (maxLane + 1) * LANE_W;
  const svgHeight = commits.length * ROW_H;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">加载中...</div>
        ) : commits.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">无提交历史</div>
        ) : (
          <div className="relative">
            {/* SVG 图形层 */}
            <svg
              className="absolute left-0 top-0 pointer-events-none"
              width={graphWidth}
              height={svgHeight}
            >
              {/* 先画连线 */}
              {commits.map((commit, row) => {
                const gc = graphCommits.get(commit.hash);
                if (!gc) return null;
                const x1 = laneX(gc.lane);
                const y1 = rowY(row);
                return gc.parents.map((parentHash, pi) => {
                  const pgc = graphCommits.get(parentHash);
                  if (!pgc) return null;
                  const parentRow = commits.findIndex((c) => c.hash === parentHash);
                  if (parentRow === -1) return null;
                  const x2 = laneX(pgc.parentLanes[pi] ?? gc.lane);
                  const y2 = rowY(parentRow);
                  const color = branchColor(gc.lane);
                  const midY = (y1 + y2) / 2;
                  return (
                    <path
                      key={`${commit.hash}-${pi}`}
                      d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                      fill="none"
                      stroke={color}
                      strokeWidth={1.5}
                      opacity={0.7}
                    />
                  );
                });
              })}
              {/* 再画圆点 */}
              {commits.map((commit, row) => {
                const gc = graphCommits.get(commit.hash);
                if (!gc) return null;
                const cx = laneX(gc.lane);
                const cy = rowY(row);
                const color = branchColor(gc.lane);
                return (
                  <circle
                    key={commit.hash}
                    cx={cx}
                    cy={cy}
                    r={gc.isHead ? DOT_R + 1 : DOT_R - 1}
                    fill={color}
                    stroke={gc.isHead ? '#ffffff' : 'none'}
                    strokeWidth={gc.isHead ? 1.5 : 0}
                  />
                );
              })}
            </svg>
            {/* 提交列表 */}
            <div>
              {commits.map((commit) => {
                const gc = graphCommits.get(commit.hash);
                const paddingLeft = graphWidth + 8;
                const isExpanded = expandedHash === commit.hash;
                return (
                  <div key={commit.hash}>
                    <div
                      onClick={() => setExpandedHash(isExpanded ? null : commit.hash)}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 border-b border-border/20 py-1.5 pr-2 transition-colors hover:bg-accent/40',
                        isExpanded && 'bg-accent/30',
                      )}
                      style={{ paddingLeft }}
                    >
                      {/* 分支标签 */}
                      <div className="flex shrink-0 items-center gap-1">
                        {gc?.branches.map((br, bi) => (
                          <span
                            key={bi}
                            className={cn(
                              'rounded-full px-1.5 py-0.5 text-[9px] font-medium',
                              br.isRemote
                                ? 'bg-muted text-muted-foreground'
                                : 'bg-primary/15 text-primary',
                            )}
                          >
                            {br.name}
                          </span>
                        ))}
                      </div>
                      {/* 提交信息 */}
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                        {commit.message}
                      </span>
                      {/* hash */}
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {commit.shortHash}
                      </span>
                    </div>
                    {isExpanded && (
                      <div
                        className="border-b border-border/20 bg-muted/20 py-1.5 text-xs"
                        style={{ paddingLeft }}
                      >
                        <div className="flex items-center gap-3 text-muted-foreground">
                          <span>作者: {commit.author}</span>
                          <span>日期: {commit.date}</span>
                          <span className="font-mono">{commit.hash.slice(0, 12)}</span>
                        </div>
                        {gc && gc.parents.length > 1 && (
                          <div className="mt-1 text-[10px] text-amber-400">
                            ↳ 合并提交({gc.parents.length} 个父提交)
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
