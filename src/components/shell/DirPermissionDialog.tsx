import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

/**
 * 敏感目录(桌面/文稿/下载、iCloud、移动硬盘等外置卷)首次访问前的
 * 授权询问:「允许」会持久记住(sqlite),此后同一目录及其子目录不再询问。
 */
export function DirPermissionDialog({
  path,
  busy,
  onResolve,
}: {
  path: string | null;
  busy: boolean;
  onResolve: (allow: boolean) => void;
}) {
  return (
    <Dialog
      open={path !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onResolve(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>允许访问该目录?</DialogTitle>
          <DialogDescription>
            该目录位于受保护位置(如 文稿、桌面、下载、iCloud 云盘 或移动硬盘/外置卷)。
            允许后 Combo 会记住授权,之后访问该目录及其子目录不再重复询问。
          </DialogDescription>
        </DialogHeader>
        <div className="break-all rounded-lg border border-input-border bg-muted/40 p-2.5 font-mono text-xs text-foreground">
          {path}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => onResolve(false)}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => onResolve(true)}>
            {busy ? '授权中…' : '允许'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
