import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AutomationInput,
  createAutomation,
  deleteAutomation,
  listAutomationRuns,
  listAutomations,
  runAutomationNow,
  updateAutomation,
} from '../lib/api';

/** 全部自动化任务(不带项目过滤;面板内展示所有项目的任务)。 */
export function useAutomations() {
  return useQuery({
    queryKey: ['automations'],
    queryFn: () => listAutomations(),
    refetchInterval: 15_000,
  });
}

/** 某自动化任务的运行历史。 */
export function useAutomationRuns(automationId: string | null) {
  return useQuery({
    queryKey: ['automation-runs', automationId],
    queryFn: () => listAutomationRuns(automationId!),
    enabled: !!automationId,
  });
}

export function useCreateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AutomationInput) => createAutomation(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });
}

export function useUpdateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<AutomationInput> }) =>
      updateAutomation(vars.id, vars.input),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['automations'] });
      qc.invalidateQueries({ queryKey: ['automation-runs', vars.id] });
    },
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAutomation(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });
}

export function useRunAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runAutomationNow(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ['automations'] });
      qc.invalidateQueries({ queryKey: ['automation-runs', id] });
    },
  });
}
