import { useEffect, useRef, useState, useCallback } from 'react';
import { listFiles } from '../lib/api';
import type { Api } from '../lib/api/types';

interface FlatEntry {
  path: string;
  name: string;
  isDir: boolean;
}

const MAX_DEPTH = 4;
const MAX_FILES = 500;

/**
 * 加载工作区所有文件的扁平列表(深度优先递归)。
 * 返回文件路径数组,用于 @ 搜索。
 */
export function useFileIndex(workspaceId: string | undefined) {
  const [files, setFiles] = useState<FlatEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef<Record<string, Api.FileEntry[]>>({});

  const loadDir = useCallback(
    async (dir: string): Promise<Api.FileEntry[]> => {
      if (cacheRef.current[dir]) return cacheRef.current[dir];
      const entries = await listFiles(workspaceId!, dir);
      cacheRef.current[dir] = entries;
      return entries;
    },
    [workspaceId],
  );

  const loadAll = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    cacheRef.current = {};
    const acc: FlatEntry[] = [];

    async function walk(dir: string, depth: number) {
      if (acc.length >= MAX_FILES || depth > MAX_DEPTH) return;
      try {
        const entries = await loadDir(dir);
        const dirEntries = entries.filter((e) => e.type === 'dir');
        const fileEntries = entries.filter((e) => e.type !== 'dir');
        for (const f of fileEntries) {
          acc.push({ path: f.path, name: f.name, isDir: false });
          if (acc.length >= MAX_FILES) return;
        }
        for (const d of dirEntries) {
          acc.push({ path: d.path, name: d.name, isDir: true });
          await walk(d.path, depth + 1);
        }
      } catch {
        /* skip */
      }
    }

    await walk('', 0);
    setFiles(acc);
    setLoading(false);
  }, [workspaceId, loadDir]);

  useEffect(() => {
    setFiles([]);
    void loadAll();
  }, [loadAll]);

  return { files, loading };
}
