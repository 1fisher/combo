import type { Api } from './types';
import { apiRequest } from './client';
import { getClientId } from '../clientId';

export * from './client';

export function listWorkspaces(): Promise<Api.Workspace[]> {
  return apiRequest('/v1/workspaces');
}

export function createWorkspace(
  path: string,
): Promise<Api.Workspace> {
  // 后端从请求体校验 client_id(UUID),而不是查询参数
  return apiRequest('/v1/workspaces', {
    method: 'POST',
    body: { path, client_id: getClientId(), backend: 'combo-cli' },
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

/** 更换 workspace 绑定目录:更新 sqlite 元数据。 */
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

// 文件服务:combo-cli serve 提供的受限本地读写(路径必须相对工作区根目录)
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

export interface ContentSearchResult {
  path: string;
  name: string;
  line: number | null;
  content: string;
}

export function searchFiles(
  workspaceId: string,
  params: {
    q: string;
    path?: string;
    regex?: boolean;
    caseSensitive?: boolean;
    wholeWord?: boolean;
  },
): Promise<ContentSearchResult[]> {
  const query: Record<string, string> = { q: params.q };
  if (params.path) query.path = params.path;
  if (params.regex) query.regex = 'true';
  if (params.caseSensitive) query.case_sensitive = 'true';
  if (params.wholeWord) query.whole_word = 'true';
  return apiRequest(`/v1/workspaces/${workspaceId}/files/search`, { query });
}

// Git 服务:combo-cli serve 本地端点,在 workspace 根目录(或 `repo` 指定的一级子目录)执行 git 子命令
export function getGitStatus(workspaceId: string, repo?: string): Promise<Api.GitStatus> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/status`, {
    query: repo ? { repo } : undefined,
  });
}

export function getGitRepos(workspaceId: string): Promise<Api.GitRepos> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/repos`);
}

export function getGitDiff(
  workspaceId: string,
  path?: string,
  repo?: string
): Promise<Api.GitDiff> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/diff`, {
    query: path || repo ? { ...(path ? { path } : {}), ...(repo ? { repo } : {}) } : undefined,
  });
}

export function getGitDiffStaged(
  workspaceId: string,
  path?: string,
  repo?: string
): Promise<Api.GitDiff> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/diff/staged`, {
    query: path || repo ? { ...(path ? { path } : {}), ...(repo ? { repo } : {}) } : undefined,
  });
}

export function getGitDiffHead(
  workspaceId: string,
  path?: string,
  repo?: string
): Promise<Api.GitDiff> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/diff/head`, {
    query: path || repo ? { ...(path ? { path } : {}), ...(repo ? { repo } : {}) } : undefined,
  });
}

export function getGitFileAtHead(
  workspaceId: string,
  path: string,
  repo?: string
): Promise<Api.GitFileAtHead> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/file`, {
    query: { path, ...(repo ? { repo } : {}) },
  });
}

export function gitStage(
  workspaceId: string,
  paths: string[],
  repo?: string
): Promise<{ ok: boolean }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/stage`, {
    method: 'POST',
    body: { paths, ...(repo ? { repo } : {}) },
  });
}

export function gitUnstage(
  workspaceId: string,
  paths: string[],
  repo?: string
): Promise<{ ok: boolean }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/unstage`, {
    method: 'POST',
    body: { paths, ...(repo ? { repo } : {}) },
  });
}

export function gitDiscard(
  workspaceId: string,
  paths: string[],
  repo?: string
): Promise<{ ok: boolean }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/discard`, {
    method: 'POST',
    body: { paths, ...(repo ? { repo } : {}) },
  });
}

export function gitCommit(
  workspaceId: string,
  message: string,
  repo?: string
): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/commit`, {
    method: 'POST',
    body: { message, ...(repo ? { repo } : {}) },
  });
}

/** 读取「git 提交署名」全局开关(配置文件缺省时后端默认开启)。 */
export function getCommitAttribution(): Promise<{ enabled: boolean }> {
  return apiRequest('/v1/settings/commit-attribution');
}

/** 写入「git 提交署名」全局开关(持久化到 combo-cli.toml)。 */
export function setCommitAttribution(enabled: boolean): Promise<{ enabled: boolean }> {
  return apiRequest('/v1/settings/commit-attribution', {
    method: 'POST',
    body: { enabled },
  });
}

export function gitPush(workspaceId: string, repo?: string): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/push`, {
    method: 'POST',
    query: repo ? { repo } : undefined,
  });
}

export function gitPull(workspaceId: string, repo?: string): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/pull`, {
    method: 'POST',
    query: repo ? { repo } : undefined,
  });
}

export function gitFetch(workspaceId: string, repo?: string): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/fetch`, {
    method: 'POST',
    query: repo ? { repo } : undefined,
  });
}

export function getGitBranchInfo(
  workspaceId: string,
  repo?: string
): Promise<Api.GitBranchInfo> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/branch-info`, {
    query: repo ? { repo } : undefined,
  });
}

export function getGitBranches(workspaceId: string, repo?: string): Promise<Api.GitBranchList> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/branches`, {
    query: repo ? { repo } : undefined,
  });
}

export function gitCheckout(
  workspaceId: string,
  branch: string,
  repo?: string
): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/checkout`, {
    method: 'POST',
    body: { branch, ...(repo ? { repo } : {}) },
  });
}

export function gitCreateBranch(
  workspaceId: string,
  branch: string,
  repo?: string
): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/branch/create`, {
    method: 'POST',
    body: { branch, ...(repo ? { repo } : {}) },
  });
}

export function gitDeleteBranch(
  workspaceId: string,
  branch: string,
  repo?: string,
  force = false
): Promise<{ ok: boolean; output: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/branch/delete`, {
    method: 'POST',
    body: { branch, force, ...(repo ? { repo } : {}) },
  });
}

export function getGitLog(
  workspaceId: string,
  limit?: number,
  repo?: string
): Promise<Api.GitLog> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/log`, {
    query: {
      ...(limit !== undefined ? { limit: String(limit) } : {}),
      ...(repo ? { repo } : {}),
    },
  });
}

export function getGitCommitFiles(
  workspaceId: string,
  hash: string,
  repo?: string
): Promise<{ files: Api.GitCommitFile[] }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/commit/files`, {
    query: { hash, ...(repo ? { repo } : {}) },
  });
}

export function getGitCommitDiff(
  workspaceId: string,
  hash: string,
  path?: string,
  repo?: string
): Promise<{ diff: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/commit/diff`, {
    query: { hash, ...(path ? { path } : {}), ...(repo ? { repo } : {}) },
  });
}

// 技能:combo-cli serve 本地端点,扫描技能目录
// 传 workspace_id 时项目级技能按该 workspace 根目录扫描(.agents/skills 等),
// 不传则回退到 serve 进程 CWD 相对路径(CLI 模式)。
export function listSkills(workspaceId?: string | null): Promise<Api.Skill[]> {
  return apiRequest('/v1/skills', {
    ...(workspaceId ? { query: { workspace_id: workspaceId } } : {}),
  });
}

// MCP server:combo-cli serve 本地端点,读写配置文件 [mcp.<name>]
export function listMcpServers(): Promise<Api.McpServer[]> {
  return apiRequest('/v1/mcp');
}

export function upsertMcpServer(
  req: { name: string; type: string; command?: string; url?: string },
): Promise<{ ok: boolean; name: string }> {
  return apiRequest('/v1/mcp', {
    method: 'POST',
    body: { name: req.name, type: req.type, command: req.command, url: req.url },
  });
}

export function removeMcpServer(name: string): Promise<{ ok: boolean; name: string }> {
  return apiRequest('/v1/mcp/remove', { method: 'POST', body: { name } });
}

export function testMcpServer(
  req: { type: string; command?: string; url?: string },
): Promise<Api.McpTestResult> {
  return apiRequest('/v1/mcp/test', {
    method: 'POST',
    body: { type: req.type, command: req.command, url: req.url },
  });
}

// 服务器目录浏览:combo-cli serve 本地端点,供浏览器/移动端在远端打开服务器上的项目目录
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

// 配置:透传
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

// ---------- agent / model 选择 ----------

/** 获取 agent 当前信息(含 model/model_cfg)。 */
export function getAgentInfo(workspaceId: string): Promise<Api.AgentInfo> {
  return apiRequest(`/v1/workspaces/${workspaceId}/agent`);
}

/** 获取可用 provider 列表(含每个 provider 的模型列表)。 */
export function getWorkspaceProviders(workspaceId: string): Promise<Api.ProviderEntry[]> {
  return apiRequest(`/v1/workspaces/${workspaceId}/providers`);
}

/** 获取 provider 列表(全局,不绑定 workspace)。 */
export function getGlobalProviders(): Promise<Api.ProviderEntry[]> {
  return apiRequest('/v1/providers');
}

/** 拉取 provider 支持的远程模型列表(需要 API Key)。 */
export function fetchProviderModels(
  workspaceId: string,
  req: { providerId: string; apiKey?: string; apiEndpoint?: string; providerType?: string },
): Promise<{ provider: string; models: { id: string; name: string }[] }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/providers/fetch-models`, {
    method: 'POST',
    body: {
      provider_id: req.providerId,
      api_key: req.apiKey,
      api_endpoint: req.apiEndpoint,
      provider_type: req.providerType,
    },
  });
}

/** 拉取 provider 支持的远程模型列表(全局,不绑定 workspace)。 */
export function fetchGlobalProviderModels(
  req: { providerId: string; apiKey?: string; apiEndpoint?: string; providerType?: string },
): Promise<{ provider: string; models: { id: string; name: string }[] }> {
  return apiRequest('/v1/providers/fetch-models', {
    method: 'POST',
    body: {
      provider_id: req.providerId,
      api_key: req.apiKey,
      api_endpoint: req.apiEndpoint,
      provider_type: req.providerType,
    },
  });
}

/** 持久化保存 provider 的 API Key 到配置文件。 */
export function saveProviderKey(
  workspaceId: string,
  req: { providerId: string; apiKey: string; providerType?: string; baseUrl?: string },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/providers/save-key`, {
    method: 'POST',
    body: {
      provider_id: req.providerId,
      api_key: req.apiKey,
      provider_type: req.providerType,
      base_url: req.baseUrl,
    },
  });
}

/** 持久化保存 provider 的 API Key(全局,不绑定 workspace)。 */
export function saveGlobalProviderKey(
  req: { providerId: string; apiKey: string; providerType?: string; baseUrl?: string },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest('/v1/providers/save-key', {
    method: 'POST',
    body: {
      provider_id: req.providerId,
      api_key: req.apiKey,
      provider_type: req.providerType,
      base_url: req.baseUrl,
    },
  });
}

/** 追加一个 API Key 到 provider(已存在则视为切换激活;无激活 key 时自动激活)。 */
export function addProviderKey(
  workspaceId: string,
  req: { providerId: string; apiKey: string; name?: string },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/providers/keys`, {
    method: 'POST',
    body: {
      provider_id: req.providerId,
      api_key: req.apiKey,
      name: req.name,
    },
  });
}

/** 按下标切换 provider 的激活 API Key。 */
export function activateProviderKey(
  workspaceId: string,
  req: { providerId: string; keyIndex: number },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/providers/keys/activate`, {
    method: 'POST',
    body: { provider_id: req.providerId, key_index: req.keyIndex },
  });
}

/** 按下标删除 provider 的 API Key(删除激活 key 后自动激活剩余第一个)。 */
export function removeProviderKey(
  workspaceId: string,
  req: { providerId: string; keyIndex: number },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/providers/keys/remove`, {
    method: 'POST',
    body: { provider_id: req.providerId, key_index: req.keyIndex },
  });
}

/** 按下标设置 provider 的 API Key 名称(name 留空则清除名称)。 */
export function renameProviderKey(
  workspaceId: string,
  req: { providerId: string; keyIndex: number; name?: string },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/providers/keys/rename`, {
    method: 'POST',
    body: { provider_id: req.providerId, key_index: req.keyIndex, name: req.name },
  });
}

/** 追加一个 API Key 到 provider(全局,不绑定 workspace)。 */
export function addGlobalProviderKey(
  req: { providerId: string; apiKey: string; name?: string },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest('/v1/providers/keys', {
    method: 'POST',
    body: { provider_id: req.providerId, api_key: req.apiKey, name: req.name },
  });
}

/** 按下标切换 provider 的激活 API Key(全局,不绑定 workspace)。 */
export function activateGlobalProviderKey(
  req: { providerId: string; keyIndex: number },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest('/v1/providers/keys/activate', {
    method: 'POST',
    body: { provider_id: req.providerId, key_index: req.keyIndex },
  });
}

/** 按下标删除 provider 的 API Key(全局,不绑定 workspace)。 */
export function removeGlobalProviderKey(
  req: { providerId: string; keyIndex: number },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest('/v1/providers/keys/remove', {
    method: 'POST',
    body: { provider_id: req.providerId, key_index: req.keyIndex },
  });
}

/** 按下标设置 provider 的 API Key 名称(全局,不绑定 workspace;name 留空则清除)。 */
export function renameGlobalProviderKey(
  req: { providerId: string; keyIndex: number; name?: string },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest('/v1/providers/keys/rename', {
    method: 'POST',
    body: { provider_id: req.providerId, key_index: req.keyIndex, name: req.name },
  });
}

/** 新增自定义 provider(写入配置文件 `[providers.<id>]`;类型缺省 openai-compat)。 */
export function createProvider(
  workspaceId: string,
  req: {
    id: string;
    name?: string;
    providerType?: string;
    baseUrl?: string;
    apiKey?: string;
    defaultLargeModelId?: string;
  },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/providers/create`, {
    method: 'POST',
    body: {
      id: req.id,
      name: req.name,
      type: req.providerType,
      base_url: req.baseUrl,
      api_key: req.apiKey,
      default_large_model_id: req.defaultLargeModelId,
    },
  });
}

/** 删除自定义 provider(连同其全部 API Key 与模型缓存;内置 provider 不可删)。 */
export function removeProvider(
  workspaceId: string,
  req: { providerId: string },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest(`/v1/workspaces/${workspaceId}/providers/remove`, {
    method: 'POST',
    body: { provider_id: req.providerId },
  });
}

/** 新增自定义 provider(全局,不绑定 workspace)。 */
export function createGlobalProvider(
  req: {
    id: string;
    name?: string;
    providerType?: string;
    baseUrl?: string;
    apiKey?: string;
    defaultLargeModelId?: string;
  },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest('/v1/providers/create', {
    method: 'POST',
    body: {
      id: req.id,
      name: req.name,
      type: req.providerType,
      base_url: req.baseUrl,
      api_key: req.apiKey,
      default_large_model_id: req.defaultLargeModelId,
    },
  });
}

/** 删除自定义 provider(全局,不绑定 workspace)。 */
export function removeGlobalProvider(
  req: { providerId: string },
): Promise<{ ok: boolean; provider: string }> {
  return apiRequest('/v1/providers/remove', {
    method: 'POST',
    body: { provider_id: req.providerId },
  });
}

/** 设置 workspace 当前使用的模型。 */
export function setWorkspaceModel(
  workspaceId: string,
  model: Api.SelectedModel,
  modelType: Api.ModelType = 'large',
  scope: Api.ConfigScope = 1
): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/config/model`, {
    method: 'POST',
    body: { model, model_type: modelType, scope } satisfies Api.ConfigModelRequest,
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
  connected: boolean;
  error?: string;
}

/**
 * 启动桌面端到中转服务器的反向隧道。
 * @param wsUrl 中转 WebSocket 地址 (wss://...)
 * @param token 访问令牌
 */
export function startRelayTunnel(wsUrl: string, token: string): Promise<RelayStatus> {
  // 后端 test_connection 同步等待最多 5s,给 15s 总超时余量
  return apiRequest('/v1/relay/start', { method: 'POST', body: { url: wsUrl, token }, timeoutMs: 15000 });
}

/** 停止隧道。 */
export function stopRelayTunnel(): Promise<RelayStatus> {
  return apiRequest('/v1/relay/stop', { method: 'POST' });
}

/** 查询隧道状态。 */
export function getRelayStatus(): Promise<RelayStatus> {
  return apiRequest('/v1/relay/status');
}

// ---------- 用量统计 ----------

export interface ModelUsageStats {
  provider: string;
  model: string;
  request_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
}

export interface DailyUsageStats {
  date: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  request_count: number;
}

export interface UsageStats {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cost: number;
  total_requests: number;
  by_model: ModelUsageStats[];
  daily: DailyUsageStats[];
}

export function getUsageStats(): Promise<UsageStats> {
  return apiRequest('/v1/stats/usage');
}

// ---------- 自动化(定时任务) ----------

export type AutomationInput = {
  workspace_id: string;
  name: string;
  prompt: string;
  schedule: Api.AutomationSchedule;
  enabled?: boolean;
};

/** 列出全部自动化任务(可选按项目过滤)。 */
export function listAutomations(workspaceId?: string): Promise<Api.Automation[]> {
  return apiRequest('/v1/automations', {
    query: workspaceId ? { workspace_id: workspaceId } : undefined,
  });
}

/** 获取单个自动化任务。 */
export function getAutomation(id: string): Promise<Api.Automation> {
  return apiRequest(`/v1/automations/${id}`);
}

/** 创建自动化任务。 */
export function createAutomation(input: AutomationInput): Promise<Api.Automation> {
  return apiRequest('/v1/automations', { method: 'POST', body: input });
}

/** 更新自动化任务(部分字段)。 */
export function updateAutomation(
  id: string,
  input: Partial<AutomationInput>
): Promise<Api.Automation> {
  return apiRequest(`/v1/automations/${id}`, { method: 'PATCH', body: input });
}

/** 删除自动化任务(含运行历史)。 */
export function deleteAutomation(id: string): Promise<void> {
  return apiRequest(`/v1/automations/${id}`, { method: 'DELETE' });
}

/** 手动立即触发一次自动化任务(不推进原排期)。 */
export function runAutomationNow(id: string): Promise<{ ok: boolean; started: boolean }> {
  return apiRequest(`/v1/automations/${id}/run`, { method: 'POST' });
}

/** 查询自动化任务的运行历史。 */
export function listAutomationRuns(id: string): Promise<Api.AutomationRun[]> {
  return apiRequest(`/v1/automations/${id}/runs`);
}

