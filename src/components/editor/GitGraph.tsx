import { useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus, FileText, GitMerge, MinusCircle, PencilLine } from 'lucide-react';
import { getGitLog, getGitCommitFiles } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

interface Props {
  workspaceId: string;
  onShowCommitDiff: (hash: string, path: string) => void;
}

interface GraphCommit extends Api.GitCommitInfo {
  lane: number;
  parentLanes: number[];
}

const LANE_COLORS = [
  '#e06c75', '#61afef', '#98c379', '#e5c07b',
  '#c678dd', '#56b6c2', '#d19a66', '#ff6b9d',
];

const ROW_H = 32;
const DOT_R = 5;
const LANE_W = 18;
const GRAPH_W = 60;

function laneX(lane: number): number {
  return 10 + lane * LANE_W;
}

function branchColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function computeLanes(commits: Api.GitCommitInfo[]): Map<string, GraphCommit> {
  const result = new Map<string, GraphCommit>();
  if (!commits || commits.length === 0) return result;

  const activeLanes: (string | null)[] = [];
  const hashToLane = new Map<string, number>();

  for (const commit of commits) {
    const parents = commit.parents ?? [];
    let lane = hashToLane.get(commit.hash);
    if (lane === undefined) {
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

    const parentLanes: number[] = [];
    for (let i = 0; i < parents.length; i++) {
      const parentHash = parents[i];
      if (i === 0) {
        if (!hashToLane.has(parentHash)) hashToLane.set(parentHash, lane);
        parentLanes.push(lane);
      } else {
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

/** 计算某行到其父提交之间的所有连线段(lane, 从y到y) */
interface LineSegment {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  /** 贝塞尔曲线的控制点(如果需要弯曲) */
  curve?: boolean;
}

/**
 * 计算每行需要的连线。每行内部,线从圆点(row 中点)向下画到行底。
 * 同时检查:是否有从上方穿过的 lane 线(到更下方的父提交)。
 * 返回每行的线段列表,坐标相对于行内(0..rowHeight)。
 */
function buildRowLines(
  commit: Api.GitCommitInfo,
  gc: GraphCommit,
  row: number,
  commits: Api.GitCommitInfo[],
  graphCommits: Map<string, GraphCommit>,
  rowHeight: number,
): { lines: LineSegment[]; cy: number } {
  const lines: LineSegment[] = [];
  const cy = ROW_H / 2; // 圆点在 commit 行中点
  const cx = laneX(gc.lane);

  // 1. 从本 commit 向下到父提交的线
  gc.parents.forEach((parentHash, pi) => {
    const parentRow = commits.findIndex((c) => c.hash === parentHash);
    if (parentRow === -1) return;

    const parentLane = gc.parentLanes[pi] ?? gc.lane;
    const px = laneX(parentLane);
    const pColor = branchColor(parentLane);

    if (pi === 0 && parentLane === gc.lane) {
      // 第一个父提交,同 lane:直线从圆点到行底
      lines.push({ key: `p-${pi}`, x1: cx, y1: cy, x2: cx, y2: rowHeight, color: branchColor(gc.lane) });
    } else {
      // 不同 lane(merge 的额外父):曲线从圆点到目标 lane,再向下
      lines.push({
        key: `p-${pi}`,
        x1: cx,
        y1: cy,
        x2: px,
        y2: rowHeight,
        color: pColor,
        curve: true,
      });
    }
  });

  // 2. 穿过本行的 lane 线:从上方某 commit 到下方更远的父提交
  // 这些线在本行范围内是竖直的(从行顶到行底)
  for (let r = 0; r < row; r++) {
    const aboveGc = graphCommits.get(commits[r].hash);
    if (!aboveGc) continue;
    aboveGc.parents.forEach((ph, ppi) => {
      const parentRow = commits.findIndex((c) => c.hash === ph);
      if (parentRow === -1) return;
      // 线从 r 向下到 parentRow,穿过本行?
      if (parentRow > row) {
        const lane = aboveGc.parentLanes[ppi];
        if (lane !== undefined && lane !== gc.lane) {
          const lx = laneX(lane);
          // 避免重复
          if (!lines.some((l) => Math.abs(l.x1 - lx) < 1 && l.y1 === 0)) {
            lines.push({ key: `pass-r${r}-${ppi}`, x1: lx, y1: 0, x2: lx, y2: rowHeight, color: branchColor(lane) });
          }
        }
      }
    });
  }

  // 3. 从上方进入本行圆点的线(本 commit 的子提交的线在本行顶部)
  // 如果本 commit 不是 HEAD(有子提交),子提交的线从上方进入本行
  for (let r = 0; r < row; r++) {
    const childGc = graphCommits.get(commits[r].hash);
    if (!childGc) continue;
    childGc.parents.forEach((ph, ppi) => {
      if (ph !== commit.hash) return;
      const childLane = childGc.lane;
      const cx2 = laneX(childLane);
      // 子提交在 row r,本 commit 在 row。线从子提交圆点向下进入本行顶部
      if (childLane === gc.lane) {
        // 同 lane:线进入本行顶部,连到圆点
        if (!lines.some((l) => Math.abs(l.x1 - cx2) < 1 && l.y1 === 0 && l.y2 === cy)) {
          lines.push({ key: `in-r${r}-${ppi}`, x1: cx2, y1: 0, x2: cx, y2: cy, color: branchColor(gc.lane) });
        }
      } else {
        // 不同 lane:线从上方进入,弯曲到圆点
        if (!lines.some((l) => Math.abs(l.x1 - cx2) < 1 && l.y1 === 0)) {
          lines.push({ key: `in-r${r}-${ppi}`, x1: cx2, y1: 0, x2: cx, y2: cy, color: branchColor(childLane), curve: true });
        }
      }
    });
  }

  return { lines, cy };
}

export function GitGraph({ workspaceId, onShowCommitDiff }: Props) {
  const [commits, setCommits] = useState<Api.GitCommitInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<Api.GitCommitFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  // 测量展开详情区的高度,让连线能穿过
  const detailRef = useRef<HTMLDivElement>(null);
  const [detailHeight, setDetailHeight] = useState(0);

  useEffect(() => {
    if (!expandedHash) {
      setDetailHeight(0);
      return;
    }
    // 等下一帧测量
    requestAnimationFrame(() => {
      setDetailHeight(detailRef.current?.offsetHeight ?? 0);
    });
  }, [expandedHash, commitFiles, filesLoading]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getGitLog(workspaceId, 50)
      .then(({ commits }) => { if (!cancelled) setCommits(commits); })
      .catch(() => { if (!cancelled) setCommits([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const graphCommits = useMemo(() => computeLanes(commits), [commits]);

  async function toggleExpand(hash: string) {
    if (expandedHash === hash) {
      setExpandedHash(null);
      setCommitFiles([]);
      return;
    }
    setExpandedHash(hash);
    setCommitFiles([]);
    setFilesLoading(true);
    try {
      const { files } = await getGitCommitFiles(workspaceId, hash);
      setCommitFiles(files);
    } catch {
      setCommitFiles([]);
    } finally {
      setFilesLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">加载中...</div>
        ) : commits.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted-foreground">无提交历史</div>
        ) : (
          commits.map((commit, row) => {
            const gc = graphCommits.get(commit.hash);
            if (!gc) return null;
            const isExpanded = expandedHash === commit.hash;
            const isMerge = gc.parents.length > 1;
            // 展开 + 有详情高度时,SVG 高度 = ROW_H + 详情高度
            const rowTotalH = isExpanded ? ROW_H + detailHeight : ROW_H;
            const { lines, cy } = buildRowLines(commit, gc, row, commits, graphCommits, rowTotalH);

            return (
              <div key={commit.hash} className="relative">
                {/* SVG:覆盖整行(含展开区) */}
                <svg
                  className="pointer-events-none absolute left-0 top-0 z-10"
                  width={GRAPH_W}
                  height={rowTotalH}
                >
                  {lines.map((seg) =>
                    seg.curve ? (
                      (() => {
                        // 贝塞尔曲线:控制点在 y 方向居中分布,产生平滑圆角
                        // 第一个控制点保持起点的 x,第二个控制点保持终点的 x
                        // y 方向各取 1/2 处,形成自然的弧线
                        const midY1 = seg.y1 + (seg.y2 - seg.y1) * 0.5;
                        return (
                          <path
                            key={seg.key}
                            d={`M ${seg.x1} ${seg.y1} C ${seg.x1} ${midY1}, ${seg.x2} ${midY1}, ${seg.x2} ${seg.y2}`}
                            fill="none"
                            stroke={seg.color}
                            strokeWidth={1.5}
                            opacity={0.6}
                          />
                        );
                      })()
                    ) : (
                      <line
                        key={seg.key}
                        x1={seg.x1}
                        y1={seg.y1}
                        x2={seg.x2}
                        y2={seg.y2}
                        stroke={seg.color}
                        strokeWidth={1.5}
                        opacity={0.6}
                      />
                    )
                  )}
                  {/* merge 提交的外环 */}
                  {isMerge && (
                    <circle cx={laneX(gc.lane)} cy={cy} r={DOT_R + 3} fill="none" stroke={branchColor(gc.lane)} strokeWidth={1} opacity={0.4} />
                  )}
                  {/* 圆点 */}
                  <circle
                    cx={laneX(gc.lane)}
                    cy={cy}
                    r={DOT_R}
                    fill={branchColor(gc.lane)}
                    stroke={gc.isHead ? '#fff' : 'transparent'}
                    strokeWidth={gc.isHead ? 1.5 : 0}
                  />
                </svg>

                {/* commit 行(固定高度) */}
                <div
                  onClick={() => void toggleExpand(commit.hash)}
                  className={cn(
                    'relative flex cursor-pointer items-center border-b border-border/20 pr-2 transition-colors hover:bg-accent/40',
                    isExpanded && 'bg-accent/30',
                  )}
                  style={{ height: ROW_H, paddingLeft: GRAPH_W + 4 }}
                >
                  {isMerge && <GitMerge className="mr-1 h-3 w-3 shrink-0 text-purple-400" />}
                  <div className="flex shrink-0 items-center gap-0.5">
                    {gc.branches.map((br, bi) => (
                      <span
                        key={bi}
                        className={cn(
                          'rounded-full px-1.5 py-0.5 text-[9px] font-medium',
                          br.isRemote ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary',
                        )}
                      >
                        {br.name}
                      </span>
                    ))}
                  </div>
                  <span className="min-w-0 flex-1 truncate px-1.5 text-xs text-foreground">
                    {commit.message}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {commit.shortHash}
                  </span>
                </div>

                {/* 展开详情区 */}
                {isExpanded && (
                  <div
                    ref={detailRef}
                    className="border-b border-border/20 bg-muted/20 py-1.5"
                    style={{ paddingLeft: GRAPH_W + 8 }}
                  >
                    <div className="mb-1 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{commit.author}</span>
                      <span>{commit.date}</span>
                      <span className="font-mono">{commit.hash.slice(0, 12)}</span>
                      {isMerge && <span className="text-purple-400">合并提交</span>}
                    </div>
                    <div className="space-y-0.5">
                      {filesLoading ? (
                        <div className="py-1 text-[10px] text-muted-foreground">加载中...</div>
                      ) : commitFiles.length === 0 ? (
                        <div className="py-1 text-[10px] text-muted-foreground">无变更文件</div>
                      ) : (
                        commitFiles.map((f) => {
                          const fileName = f.path.split('/').pop() ?? f.path;
                          return (
                            <button
                              key={f.path}
                              onClick={() => onShowCommitDiff(commit.hash, f.path)}
                              className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-accent"
                              title={f.path}
                            >
                              <span
                                className={cn(
                                  'shrink-0',
                                  f.status === 'added' && 'text-emerald-400',
                                  f.status === 'deleted' && 'text-red-400',
                                  f.status === 'modified' && 'text-amber-400',
                                  (f.status === 'renamed' || f.status === 'copied') && 'text-blue-400',
                                )}
                              >
                                {f.status === 'added' && <FilePlus className="h-3 w-3" />}
                                {f.status === 'deleted' && <MinusCircle className="h-3 w-3" />}
                                {f.status === 'modified' && <PencilLine className="h-3 w-3" />}
                                {(f.status === 'renamed' || f.status === 'copied') && <FileText className="h-3 w-3" />}
                              </span>
                              <span className="truncate font-mono text-[11px] text-foreground">{fileName}</span>
                              {f.path.includes('/') && (
                                <span className="truncate text-[9px] text-muted-foreground/60">
                                  {f.path.slice(0, f.path.lastIndexOf('/'))}
                                </span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
