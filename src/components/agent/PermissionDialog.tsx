import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import type { Api } from '../../lib/api/types';

export type PermissionAction = 'allow' | 'allow_session' | 'deny';

export function PermissionDialog({
  permission,
  onResolve,
}: {
  permission: Api.PermissionRequest;
  onResolve: (action: PermissionAction) => void;
}) {
  return (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            权限请求:{permission.tool_name}
          </DialogTitle>
          <DialogDescription>{permission.description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-xs">
          <div>
            <span className="text-muted-foreground">Action:</span>{' '}
            <code>{permission.action}</code>
          </div>
          {permission.path && (
            <div>
              <span className="text-muted-foreground">Path:</span>{' '}
              <code>{permission.path}</code>
            </div>
          )}
          <pre className="max-h-40 overflow-auto rounded border bg-muted/40 p-2 font-mono">
            {JSON.stringify(permission.params ?? {}, null, 2)}
          </pre>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onResolve('deny')}>
            拒绝
          </Button>
          <Button variant="secondary" onClick={() => onResolve('allow_session')}>
            本次会话允许
          </Button>
          <Button onClick={() => onResolve('allow')}>允许</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
