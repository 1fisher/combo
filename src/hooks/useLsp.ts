import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelLspInstall,
  getLspInstallStatus,
  installLspServer,
  listLspServers,
  listLspPlans,
  removeLspServer,
  upsertLspServer,
} from '../lib/api';

export function useLspServers() {
  return useQuery({
    queryKey: ['lsp-servers'],
    queryFn: () => listLspServers(),
  });
}

/** LSP server 的增删操作,成功后自动刷新列表。 */
export function useLspActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['lsp-servers'] });

  const upsert = useMutation({
    mutationFn: upsertLspServer,
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: removeLspServer,
    onSuccess: invalidate,
  });

  return {
    upsert: upsert.mutateAsync,
    upserting: upsert.isPending,
    remove: remove.mutateAsync,
    removing: remove.isPending,
  };
}

/** 内置一键安装方案(install_command 已按本机包管理器解析)。 */
export function useLspPlans() {
  return useQuery({
    queryKey: ['lsp-plans'],
    queryFn: () => listLspPlans(),
  });
}

/**
 * 安装任务状态:运行中每秒轮询,结束后停止(终态保留供 UI 展示结果,
 * 下一次 install 触发时失效重取)。
 */
export function useLspInstallStatus() {
  return useQuery({
    queryKey: ['lsp-install-status'],
    queryFn: () => getLspInstallStatus(),
    refetchInterval: (query) => (query.state.data?.running ? 1000 : false),
  });
}

/** 一键安装/取消操作。 */
export function useLspInstallActions() {
  const qc = useQueryClient();
  const install = useMutation({
    mutationFn: installLspServer,
    onSuccess: () => {
      // 立即取一次状态,让轮询启动
      void qc.invalidateQueries({ queryKey: ['lsp-install-status'] });
    },
  });
  const cancel = useMutation({
    mutationFn: cancelLspInstall,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lsp-install-status'] });
    },
  });
  return {
    install: install.mutateAsync,
    installing: install.isPending,
    cancel: cancel.mutateAsync,
    cancelling: cancel.isPending,
  };
}
