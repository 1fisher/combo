import { useCallback, useRef, useState } from 'react';
import { grantDirAccess, isDirPermissionError } from '../lib/api';
import { DirPermissionDialog } from '../components/shell/DirPermissionDialog';

/**
 * 敏感目录访问授权(只询问一次):
 * 用 `run(fn)` 包裹会创建项目 / 更换目录的请求;后端返回
 * 403 dir_permission_required 时弹「允许访问该目录?」对话框,
 * 用户允许 → 持久记住授权并自动重试原请求(仅重试一次,避免死循环);
 * 取消 → 静默放弃;其它错误照常走 onError。
 */
export function useDirPermission(onError: (msg: string) => void) {
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [granting, setGranting] = useState(false);
  const retryRef = useRef<(() => Promise<void>) | null>(null);

  const run = useCallback(
    async (fn: () => Promise<void>, allowRetry = true) => {
      try {
        await fn();
      } catch (e) {
        if (allowRetry && isDirPermissionError(e)) {
          retryRef.current = () => run(fn, false);
          setPendingPath(e.path ?? '');
          return;
        }
        onError(e instanceof Error ? e.message : String(e));
      }
    },
    [onError],
  );

  const resolve = useCallback(
    async (allow: boolean) => {
      const path = pendingPath;
      if (!allow) {
        retryRef.current = null;
        setPendingPath(null);
        return;
      }
      setGranting(true);
      try {
        if (path) await grantDirAccess(path);
        const retry = retryRef.current;
        retryRef.current = null;
        setPendingPath(null);
        await retry?.();
      } catch (e) {
        retryRef.current = null;
        setPendingPath(null);
        onError(e instanceof Error ? e.message : String(e));
      } finally {
        setGranting(false);
      }
    },
    [pendingPath, onError],
  );

  const dialog = (
    <DirPermissionDialog path={pendingPath} busy={granting} onResolve={resolve} />
  );

  return { run, dialog };
}
