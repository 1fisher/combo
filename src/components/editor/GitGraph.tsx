import { useEffect, useMemo, useState } from 'react';
import { FilePlus, FileText, GitMerge, MinusCircle, PencilLine } from 'lucide-react';
import { getGitLog, getGitCommitFiles } from '../../lib/api';
import type { Api } from '../../lib/api/types';
import { cn } from '../../lib/utils';

interface Props {
  workspaceId: string;
  /** 选中提交的文件 diff 在右侧显示 */
  onShowCommitDiff: (hash: string, path: string) => void;
}

interface GraphCommit extends Api.GitCommitInfo {
  lane: number;
  parentLanes: number[];
}

const LANE_COLORS = [
  '#e06c75',
  '#61afef',
  '#98c379',
  '#e5c07b',
  '#c678dd',
  '#56b6c2',
  '#d19a66',
  '#ff6b9d',
];

const ROW_H = 32;
const DOT_R = 5;
const LANE_W = 18;
const GRAPH_W = 60;

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
        if (!hashToLane.has(parentHash)) {
          hashToLane.set(parentHash, lane);
        }
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

function laneX(lane: number): number {
  return 10 + lane * LANE_W;
}

function branchColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

/**
 * 渲染单行的 SVG 图形:从当前行顶部画连到父提交的线 + 圆点。
 * 父提交一定在下方(更老的提交),所以线总是向下延伸。
 */
function RowGraph({
  commit,
  row,
  graphCommits,
  commits,
}: {
  commit: Api.GitCommitInfo;
  row: number;
  graphCommits: Map<string, GraphCommit>;
  commits: Api.GitCommitInfo[];
}) {
  const gc = graphCommits.get(commit.hash);
  if (!gc) return null;

  const cx = laneX(gc.lane);
  const cy = ROW_H / 2;
  const color = branchColor(gc.lane);
  const isMerge = gc.parents.length > 1;

  // 画到父提交的线:父提交可能在下一行(正常),也可能更远
  const lines: React.ReactNode[] = [];
  gc.parents.forEach((parentHash, pi) => {
    const parentRow = commits.findIndex((c) => c.hash === parentHash);
    if (parentRow === -1) return; // 父提交不在列表中(超出 limit)

    const pgc = graphCommits.get(parentHash);
    if (!pgc) return;

    const parentLane = gc.parentLanes[pi] ?? gc.lane;
    const px = laneX(parentLane);
    const rowDiff = parentRow - row;

    if (rowDiff === 1) {
      // 父提交就是下一行
      if (parentLane === gc.lane) {
        // 同 lane:直线
        lines.push(
          <line key={`l-${pi}`} x1={cx} y1={cy} x2={cx} y2={ROW_H} stroke={color} strokeWidth={1.5} opacity={0.6} />,
        );
      } else {
        // 不同 lane:贝塞尔曲线
        lines.push(
          <path
            key={`l-${pi}`}
            d={`M ${cx} ${cy} C ${cx} ${ROW_H}, ${px} ${ROW_H}, ${px} ${ROW_H}`}
            fill="none"
            stroke={branchColor(parentLane)}
            strokeWidth={1.5}
            opacity={0.6}
          />,
        );
      }
    } else {
      // 父提交在更远的地方:线需要穿过中间行,画一段向下的线
      // 对于第一个父提交(同 lane):线穿到底部
      // 对于 merge 的额外父提交:从圆点弯曲到目标 lane 再向下
      if (pi === 0) {
        lines.push(
          <line key={`l-${pi}`} x1={cx} y1={cy} x2={cx} y2={ROW_H} stroke={color} strokeWidth={1.5} opacity={0.6} />,
        );
      } else {
        // 弯到 parentLane 再向下出本行底部
        const midY = ROW_H;
        lines.push(
          <path
            key={`l-${pi}`}
            d={`M ${cx} ${cy} C ${cx} ${midY}, ${px} ${midY}, ${px} ${ROW_H}`}
            fill="none"
            stroke={branchColor(parentLane)}
            strokeWidth={1.5}
            opacity={0.6}
          />,
        );
      }
    }
  });

  // 画穿过本行(非本行提交)的 lane 线
  // 检查是否有其他 lane 需要穿过本行
  const passingLanes = new Set<number>();
  // 向上看:子提交的 parentLane 如果指向非本 commit,线穿过本行
  if (row > 0) {
    for (let r = row - 1; r >= 0; r--) {
      const aboveCommit = commits[r];
      const aboveGc = graphCommits.get(aboveCommit.hash);
      if (!aboveGc) continue;
      aboveGc.parents.forEach((ph, ppi) => {
        const parentRow = commits.findIndex((c) => c.hash === ph);
        if (parentRow !== -1 && parentRow <= row && aboveGc.parentLanes[ppi] !== undefined) {
          const aboveParentLane = aboveGc.parentLanes[ppi];
          // 线从 row r 向下到 parentRow,穿过本行
          if (parentRow < row && aboveParentLane !== gc.lane) {
            passingLanes.add(aboveParentLane);
          }
        }
      });
    }
  }
  // 检查从上方来到下方父提交的线
  for (const lane of passingLanes) {
    if (lane === gc.lane) continue;
    const lx = laneX(lane);
    lines.push(
      <line key={`pass-${lane}`} x1={lx} y1={0} x2={lx} y2={ROW_H} stroke={branchColor(lane)} strokeWidth={1.5} opacity={0.4} />,
    );
  }

  return (
    <svg
      className="pointer-events-none absolute left-0 top-0"
      width={GRAPH_W}
      height={ROW_H}
    >
      {lines}
      {/* 圆点 */}
      {isMerge && (
        <circle cx={cx} cy={cy} r={DOT_R + 3} fill="none" stroke={color} strokeWidth={1} opacity={0.5} />
      )}
      <circle cx={cx} cy={cy} r={DOT_R} fill={color} stroke={gc.isHead ? '#fff' : 'transparent'} strokeWidth={gc.isHead ? 1.5 : 0} />
    </svg>
  );
}

export function GitGraph({ workspaceId, onShowCommitDiff }: Props) {
  const [commits, setCommits] = useState<Api.GitCommitInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<Api.GitCommitFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

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
            const isExpanded = expandedHash === commit.hash;
            const isMerge = (gc?.parents.length ?? 0) > 1;
            return (
              <div key={commit.hash}>
                {/* commit 行:固定高度,内部包含 SVG 图 + commit 信息 */}
                <div
                  onClick={() => void toggleExpand(commit.hash)}
                  className={cn(
                    'relative flex cursor-pointer items-center border-b border-border/20 pr-2 transition-colors hover:bg-accent/40',
                    isExpanded && 'bg-accent/30',
                  )}
                  style={{ height: ROW_H, paddingLeft: GRAPH_W + 4 }}
                >
                  {/* SVG 图形 */}
                  <RowGraph commit={commit} row={row} graphCommits={graphCommits} commits={commits} />
                  {/* merge 标记 */}
                  {isMerge && (
                    <GitMerge className="mr-1 h-3 w-3 shrink-0 text-purple-400" />
                  )}
                  {/* 分支标签 */}
                  <div className="flex shrink-0 items-center gap-0.5">
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
                  <span className="min-w-0 flex-1 truncate px-1.5 text-xs text-foreground">
                    {commit.message}
                  </span>
                  {/* hash */}
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {commit.shortHash}
                  </span>
                </div>
                {/* 展开的详情区:不影响后续行对齐 */}
                {isExpanded && (
                  <div className="border-b border-border/20 bg-muted/20 py-1.5" style={{ paddingLeft: GRAPH_W + 8 }}>
                    <div className="mb-1 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{commit.author}</span>
                      <span>{commit.date}</span>
                      <span className="font-mono">{commit.hash.slice(0, 12)}</span>
                      {isMerge && (
                        <span className="text-purple-400">合并提交</span>
                      )}
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
                              <span className="truncate font-mono text-[11px] text-foreground">
                                {fileName}
                              </span>
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
