import { useState, useCallback } from 'react';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'installing' | 'done' | 'error';

interface UpdateInfo {
  version: string;
  date?: string;
  body?: string;
}

interface UseUpdaterReturn {
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  error: string | null;
  checkForUpdate: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
}

/**
 * 应用自动更新 hook。
 * 仅在 Tauri 桌面模式下可用;浏览器模式直接返回 no-op。
 */
export function useUpdater(): UseUpdaterReturn {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkForUpdate = useCallback(async () => {
    setError(null);
    setStatus('checking');
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) {
        setUpdateInfo({
          version: update.version,
          date: update.date,
          body: update.body,
        });
        setStatus('available');
      } else {
        setUpdateInfo(null);
        setStatus('idle');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!updateInfo) return;
    setStatus('downloading');
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        setStatus('idle');
        return;
      }
      await update.downloadAndInstall();
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [updateInfo]);

  return { status, updateInfo, error, checkForUpdate, downloadAndInstall };
}
