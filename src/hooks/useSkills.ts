import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getWorkspaceConfig, listSkills, setConfigKey } from '../lib/api';

export function useSkills(workspaceId?: string | null) {
  return useQuery({
    queryKey: ['skills', workspaceId ?? null],
    queryFn: () => listSkills(workspaceId),
  });
}

export function useWorkspaceDisabledSkills(workspaceId: string | null) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['workspace-config', workspaceId],
    queryFn: () => getWorkspaceConfig(workspaceId!),
    enabled: !!workspaceId,
  });

  const disabled: string[] = q.data?.options?.disabled_skills ?? [];

  const toggle = useMutation({
    mutationFn: async (vars: { skillName: string; enable: boolean }) => {
      const current = new Set(disabled);
      if (vars.enable) {
        current.delete(vars.skillName);
      } else {
        current.add(vars.skillName);
      }
      await setConfigKey(workspaceId!, 'disabled_skills', [...current], 1);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace-config', workspaceId] });
    },
  });

  return {
    disabledSkills: disabled,
    isLoading: q.isLoading,
    isDisabled: (name: string) => disabled.includes(name),
    toggle: toggle.mutateAsync,
    toggling: toggle.isPending,
  };
}
