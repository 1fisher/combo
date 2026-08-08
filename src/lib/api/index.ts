import type { Api } from './types';
import { apiRequest } from './client';
import { getClientId } from '../clientId';

export * from './client';

export function listWorkspaces(): Promise<Api.Workspace[]> {
  return apiRequest('/v1/workspaces');
}

export function createWorkspace(
  path: string,
  backend: 'crush' | 'opencode' | 'claude_code' | 'codex' = 'crush'
): Promise<Api.Workspace> {
  // rune 从请求体校验 client_id(UUID),而不是查询参数
  return apiRequest('/v1/workspaces', {
    method: 'POST',
    body: { path, client_id: getClientId(), backend },
  });
}

export function getWorkspace(id: string): Promise<Api.Workspace> {
  return apiRequest(`/v1/workspaces/${id}`);
}

export function renameWorkspace(id: string, name: string): Promise<Api.Workspace> {
  return apiRequest(`/v1/workspaces/${id}`, {
    method: 'PATCH',
    body: { name },
  });
}

/** 更换 workspace 绑定目录:更新 sqlite 元数据并重新注册到 crush。 */
export function changeWorkspacePath(id: string, path: string): Promise<Api.Workspace> {
  return apiRequest(`/v1/workspaces/${id}`, {
    method: 'PATCH',
    body: { path },
  });
}

export function deleteWorkspace(id: string): Promise<void> {
  return apiRequest(`/v1/workspaces/${id}`, { method: 'DELETE' });
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

/** 将单条消息持久化到 combo 后端 sqlite(fire-and-forget)。 */
export function persistMessage(
  workspaceId: string,
  message: Api.Message
): Promise<void> {
  return apiRequest(
    `/v1/workspaces/${workspaceId}/sessions/${message.session_id}/messages`,
    { method: 'POST', body: message }
  );
}

export function setCurrentSession(workspaceId: string, sessionId: string): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/current-session`, {
    method: 'POST',
    body: { session_id: sessionId },
  });
}

export function deleteSession(workspaceId: string, sessionId: string): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/sessions/${sessionId}`, {
    method: 'DELETE',
  });
}

export function renameSession(
  workspaceId: string,
  sessionId: string,
  title: string
): Promise<Api.Session> {
  return apiRequest(`/v1/workspaces/${workspaceId}/sessions/${sessionId}`, {
    method: 'PATCH',
    body: { title },
  });
}

export function sendAgentMessage(
  workspaceId: string,
  req: { sessionId: string; runId: string; prompt: string; attachments?: Api.Attachment[] }
): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/agent`, {
    method: 'POST',
    body: {
      session_id: req.sessionId,
      run_id: req.runId,
      prompt: req.prompt,
      attachments: req.attachments,
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

export function setPermissionSkip(workspaceId: string, skip: boolean): Promise<{ skip: boolean }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/permissions/skip`, {
    method: 'POST',
    body: { skip },
  });
}

export function getPermissionSkip(workspaceId: string): Promise<{ skip: boolean }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/permissions/skip`);
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

// Git 服务:combo-proxy 本地端点,在 workspace 根目录执行 git 子命令
export function getGitStatus(workspaceId: string): Promise<Api.GitStatus> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/status`);
}

export function getGitDiff(
  workspaceId: string,
  path?: string
): Promise<Api.GitDiff> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/diff`, {
    query: path ? { path } : undefined,
  });
}

export function getGitDiffStaged(
  workspaceId: string,
  path?: string
): Promise<Api.GitDiff> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/diff/staged`, {
    query: path ? { path } : undefined,
  });
}

export function getGitDiffHead(
  workspaceId: string,
  path?: string
): Promise<Api.GitDiff> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/diff/head`, {
    query: path ? { path } : undefined,
  });
}

export function getGitFileAtHead(
  workspaceId: string,
  path: string
): Promise<Api.GitFileAtHead> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/file`, { query: { path } });
}

export function gitStage(
  workspaceId: string,
  paths: string[]
): Promise<{ ok: boolean }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/stage`, {
    method: 'POST',
    body: { paths },
  });
}

export function gitUnstage(
  workspaceId: string,
  paths: string[]
): Promise<{ ok: boolean }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/unstage`, {
    method: 'POST',
    body: { paths },
  });
}

export function gitDiscard(
  workspaceId: string,
  paths: string[]
): Promise<{ ok: boolean }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/discard`, {
    method: 'POST',
    body: { paths },
  });
}

export function gitCommit(
  workspaceId: string,
  message: string
): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/commit`, {
    method: 'POST',
    body: { message },
  });
}

export function gitPush(workspaceId: string): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/push`, { method: 'POST' });
}

export function gitPull(workspaceId: string): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/pull`, { method: 'POST' });
}

export function gitFetch(workspaceId: string): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/fetch`, { method: 'POST' });
}

export function getGitBranchInfo(
  workspaceId: string
): Promise<Api.GitBranchInfo> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/branch-info`);
}

export function getGitLog(
  workspaceId: string,
  limit?: number
): Promise<Api.GitLog> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/log`, {
    query: limit !== undefined ? { limit: String(limit) } : undefined,
  });
}

export function getGitCommitFiles(
  workspaceId: string,
  hash: string
): Promise<{ files: Api.GitCommitFile[] }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/commit/files`, { query: { hash } });
}

export function getGitCommitDiff(
  workspaceId: string,
  hash: string,
  path?: string
): Promise<{ diff: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/commit/diff`, {
    query: path ? { hash, path } : { hash },
  });
}

// 技能:combo-proxy 本地端点,扫描 ~/.config/crush/skills/
export function listSkills(): Promise<Api.Skill[]> {
  return apiRequest('/v1/skills');
}

// 确保 crush server 运行中(若已死则重启)。combo-proxy 本地端点。
export function ensureCrush(): Promise<{ healthy: boolean }> {
  return apiRequest('/v1/control/ensure-crush', { method: 'POST' });
}

// 服务器目录浏览:combo-proxy 本地端点,供浏览器/移动端在远端打开服务器上的项目目录
export interface HostDirEntry {
  name: string;
  path: string;
}

export interface HostDirListing {
  path: string;
  parent: string | null;
  entries: HostDirEntry[];
}

/** 返回服务器上可浏览的默认起点(家目录或受限浏览根)。 */
export function getHostHome(): Promise<{ path: string }> {
  return apiRequest('/v1/host/home');
}

/** 列出服务器上某目录的直接子目录(仅目录)。 */
export function listHostDirs(path?: string): Promise<HostDirListing> {
  return apiRequest('/v1/host/dirs', { query: path ? { path } : {} });
}

// 配置:rune 透传
export function getWorkspaceConfig(workspaceId: string): Promise<Api.WorkspaceConfig> {
  return apiRequest(`/v1/workspaces/${workspaceId}/config`);
}

export function setConfigKey(
  workspaceId: string,
  key: string,
  value: unknown,
  scope: Api.ConfigScope = 1
): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/config/set`, {
    method: 'POST',
    body: { key, value, scope } satisfies Api.ConfigSetRequest,
  });
}

// ---------- 访问令牌(移动端扫码远程连接) ----------

export interface AccessToken {
  token: string;
  label: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked: boolean;
}

export interface CreatedToken {
  token: string;
  label: string;
  created_at: number;
  expires_at: number | null;
}

/** 生成新的访问令牌(桌面端调用,嵌入二维码供移动端扫码)。 */
export function createAccessToken(label = '', ttlSecs?: number): Promise<CreatedToken> {
  const body: { label: string; ttl_secs?: number } = { label };
  if (ttlSecs !== undefined) body.ttl_secs = ttlSecs;
  return apiRequest('/v1/auth/token', { method: 'POST', body });
}

/** 列出全部令牌。 */
export function listAccessTokens(): Promise<AccessToken[]> {
  return apiRequest('/v1/auth/tokens');
}

/** 校验令牌是否有效。 */
export function verifyAccessToken(token: string): Promise<{ valid: boolean }> {
  return apiRequest('/v1/auth/verify', { query: { token } });
}

/** 撤销令牌(按 token 或全部)。 */
export function revokeAccessToken(token?: string, all = false): Promise<{ revoked: string }> {
  const query: Record<string, string> = {};
  if (all) query.all = 'true';
  else if (token) query.token = token;
  return apiRequest('/v1/auth/token/revoke', { method: 'DELETE', query });
}

// ---------- 隧道管理 ----------

export interface RelayStatus {
  running: boolean;
}

/**
 * 启动桌面端到中转服务器的反向隧道。
 * @param wsUrl 中转 WebSocket 地址 (wss://...)
 * @param token 访问令牌
 */
export function startRelayTunnel(wsUrl: string, token: string): Promise<RelayStatus> {
  return apiRequest('/v1/relay/start', { method: 'POST', body: { url: wsUrl, token } });
}

/** 停止隧道。 */
export function stopRelayTunnel(): Promise<RelayStatus> {
  return apiRequest('/v1/relay/stop', { method: 'POST' });
}

/** 查询隧道状态。 */
export function getRelayStatus(): Promise<RelayStatus> {
  return apiRequest('/v1/relay/status');
}

