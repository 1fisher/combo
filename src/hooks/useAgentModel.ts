import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateGlobalProviderKey,
  activateProviderKey,
  addGlobalProviderKey,
  addProviderKey,
  fetchGlobalProviderModels,
  fetchProviderModels,
  getAgentInfo,
  getGlobalProviders,
  getWorkspaceConfig,
  getWorkspaceProviders,
  removeGlobalProviderKey,
  removeProviderKey,
  renameGlobalProviderKey,
  renameProviderKey,
  saveGlobalProviderKey,
  saveProviderKey,
  setWorkspaceModel,
} from '../lib/api';
import type { Api } from '../lib/api/types';

/** 获取 workspace 当前 agent 信息(含模型)。 */
export function useAgentInfo(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: ['agent-info', workspaceId],
    queryFn: () => getAgentInfo(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 5_000,
    retry: false,
  });
}

/** 获取 workspace 可用 provider 和模型列表。 */
export function useProviders(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: ['providers', workspaceId],
    queryFn: () =>
      workspaceId ? getWorkspaceProviders(workspaceId) : getGlobalProviders(),
    staleTime: 30_000,
    retry: false,
  });
}

/** 获取 workspace config(含默认模型配置)。 */
export function useWorkspaceConfig(workspaceId: string | null | undefined) {
  return useQuery({
    queryKey: ['workspace-config-models', workspaceId],
    queryFn: () => getWorkspaceConfig(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30_000,
    retry: false,
  });
}

/** 设置 workspace 当前使用的模型。 */
export function useSetModel(workspaceId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      model: Api.SelectedModel;
      modelType?: Api.ModelType;
    }) => setWorkspaceModel(workspaceId!, vars.model, vars.modelType),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-info', workspaceId] });
    },
  });
}

/** 拉取 provider 支持的远程模型列表。 */
export function useFetchModels(workspaceId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      providerId: string;
      apiKey?: string;
      apiEndpoint?: string;
      providerType?: string;
    }) => {
      const req = {
        providerId: vars.providerId,
        apiKey: vars.apiKey,
        apiEndpoint: vars.apiEndpoint,
        providerType: vars.providerType,
      };
      return workspaceId
        ? fetchProviderModels(workspaceId, req)
        : fetchGlobalProviderModels(req);
    },
    onSuccess: () => {
      // 拉取到模型后刷新所有 providers 查询(workspace 的和全局的),
      // 保证 Composer 的模型选择列表能同步到最新
      qc.invalidateQueries({ queryKey: ['providers'] });
    },
  });
}

/** 持久化保存 provider 的 API Key。 */
export function useSaveProviderKey(workspaceId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      providerId: string;
      apiKey: string;
      providerType?: string;
      baseUrl?: string;
    }) => {
      const req = {
        providerId: vars.providerId,
        apiKey: vars.apiKey,
        providerType: vars.providerType,
        baseUrl: vars.baseUrl,
      };
      return workspaceId
        ? saveProviderKey(workspaceId, req)
        : saveGlobalProviderKey(req);
    },
    onSuccess: () => {
      // 保存 key 后刷新所有 providers 查询(workspace 的和全局的)
      qc.invalidateQueries({ queryKey: ['providers'] });
    },
  });
}

/**
 * provider API Key 多 key 管理:add 追加(可选命名)/ activate 切换激活 /
 * rename 设置名称 / remove 删除。任一操作成功后刷新所有 providers 查询(含 Composer 的脱敏展示)。
 */
export function useProviderKeys(workspaceId: string | null | undefined) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ['providers'] });

  const add = useMutation({
    mutationFn: (vars: { providerId: string; apiKey: string; name?: string }) =>
      workspaceId ? addProviderKey(workspaceId, vars) : addGlobalProviderKey(vars),
    onSuccess: invalidate,
  });
  const activate = useMutation({
    mutationFn: (vars: { providerId: string; keyIndex: number }) =>
      workspaceId
        ? activateProviderKey(workspaceId, vars)
        : activateGlobalProviderKey(vars),
    onSuccess: invalidate,
  });
  const rename = useMutation({
    mutationFn: (vars: { providerId: string; keyIndex: number; name?: string }) =>
      workspaceId ? renameProviderKey(workspaceId, vars) : renameGlobalProviderKey(vars),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (vars: { providerId: string; keyIndex: number }) =>
      workspaceId ? removeProviderKey(workspaceId, vars) : removeGlobalProviderKey(vars),
    onSuccess: invalidate,
  });
  return { add, activate, rename, remove };
}
