import type { Api } from './types';
import { apiRequest } from './client';
import { getClientId } from '../clientId';

export * from './client';

export function listWorkspaces(): Promise<Api.Workspace[]> {
  return apiRequest('/v1/workspaces');
}

export function createWorkspace(path: string): Promise<Api.Workspace> {
  // rune 从请求体校验 client_id(UUID),而不是查询参数
  return apiRequest('/v1/workspaces', {
    method: 'POST',
    body: { path, client_id: getClientId() },
  });
}

export function getWorkspace(id: string): Promise<Api.Workspace> {
  return apiRequest(`/v1/workspaces/${id}`);
}

export function listSessions(workspaceId: string): Promise<Api.Session[]> {
  return apiRequest(`/v1/workspaces/${workspaceId}/sessions`);
}

export function createSession(workspaceId: string, title: string): Promise<Api.Session> {
  return apiRequest(`/v1/workspaces/${workspaceId}/sessions`, {
    method: 'POST',
    body: { title },
  });
}

export function getSessionHistory(
  workspaceId: string,
  sessionId: string
): Promise<Api.Message[]> {
  return apiRequest(`/v1/workspaces/${workspaceId}/sessions/${sessionId}/history`);
}

export function setCurrentSession(workspaceId: string, sessionId: string): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/current-session`, {
    method: 'POST',
    body: { session_id: sessionId },
  });
}

export function sendAgentMessage(
  workspaceId: string,
  req: { sessionId: string; runId: string; prompt: string }
): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/agent`, {
    method: 'POST',
    body: {
      session_id: req.sessionId,
      run_id: req.runId,
      prompt: req.prompt,
    } satisfies Api.AgentMessage,
  });
}

export function cancelAgent(workspaceId: string, sessionId: string): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/agent/sessions/${sessionId}/cancel`, {
    method: 'POST',
  });
}

export function grantPermission(
  workspaceId: string,
  permission: Api.PermissionRequest,
  action: 'allow' | 'allow_session' | 'deny'
): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/permissions/grant`, {
    method: 'POST',
    body: { permission, action } satisfies Api.PermissionGrant,
  });
}

export function answerQuestion(
  workspaceId: string,
  answer: Api.QuestionAnswer
): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/questions/answer`, {
    method: 'POST',
    body: answer,
  });
}

// 文件服务:combo-proxy 提供的受限本地读写(路径必须相对工作区根目录)
export function listFiles(workspaceId: string, path = ''): Promise<Api.FileEntry[]> {
  return apiRequest(`/v1/workspaces/${workspaceId}/files/list`, { query: { path } });
}

export function getFileContent(workspaceId: string, path: string): Promise<Api.FileContent> {
  return apiRequest(`/v1/workspaces/${workspaceId}/files/content`, { query: { path } });
}

export function putFileContent(
  workspaceId: string,
  path: string,
  content: string
): Promise<Api.WriteFileResult> {
  return apiRequest(`/v1/workspaces/${workspaceId}/files/content`, {
    method: 'PUT',
    query: { path },
    body: { content },
  });
}
