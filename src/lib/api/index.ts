import type { Api } from './types';
import { apiRequest, apiRequestRaw, apiRequestBinary, apiRequestNdjson, ApiError } from './client';
import { decodeBase64 } from '../pcm';
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

/** 敏感目录访问被拦(403 dir_permission_required)时为 true。 */
export function isDirPermissionError(
  e: unknown,
): e is ApiError & { path?: string } {
  return e instanceof ApiError && e.code === 'dir_permission_required';
}

/** 列出已授权的敏感目录(允许一次后持久记住)。 */
export function listDirGrants(): Promise<Api.DirGrant[]> {
  return apiRequest<{ grants: Api.DirGrant[] }>('/v1/dir-grants').then(
    (r) => r.grants ?? [],
  );
}

/** 记住一条目录授权(幂等);此后该目录及其子目录不再询问。 */
export function grantDirAccess(path: string): Promise<{ ok: boolean; path: string }> {
  return apiRequest('/v1/dir-grants', { method: 'POST', body: { path } });
}

/** 撤销一条目录授权;撤销后下次访问该目录会重新询问。 */
export function revokeDirGrant(id: number): Promise<void> {
  return apiRequest(`/v1/dir-grants/${id}`, { method: 'DELETE' });
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

/** 清空会话消息(Composer `/clear` 命令):删除全部消息并重置上下文计数,
 * 会话本身保留(标题与 token 账目不变);run 进行中后端返回 409。 */
export function clearSession(workspaceId: string, sessionId: string): Promise<void> {
  return apiRequest(`/v1/workspaces/${workspaceId}/sessions/${sessionId}/clear`, {
    method: 'POST',
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

/** 读取「git 提交全局模型」配置(AI 生成提交信息时优先使用的模型)。 */
export function getCommitModel(): Promise<Api.CommitModelConfig> {
  return apiRequest('/v1/settings/commit-model');
}

/** 写入「git 提交全局模型」配置;provider/model 传空表示清除。 */
export function setCommitModel(cfg: Api.CommitModelConfig): Promise<Api.CommitModelConfig> {
  return apiRequest('/v1/settings/commit-model', {
    method: 'POST',
    body: cfg,
  });
}

/** AI 生成提交信息:基于已暂存 diff 与最近提交风格,不执行 git 写操作。 */
export function generateCommitMessage(
  workspaceId: string,
  repo?: string
): Promise<Api.CommitMessageResult> {
  return apiRequest(`/v1/workspaces/${workspaceId}/git/commit-message`, {
    method: 'POST',
    body: repo ? { repo } : {},
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

// LSP server:combo-cli serve 本地端点,读写配置文件 [lsp.<lang>]
export function listLspServers(): Promise<Api.LspServer[]> {
  return apiRequest('/v1/lsp');
}

export function upsertLspServer(req: {
  name: string;
  command: string;
  args?: string;
  env?: Record<string, string>;
}): Promise<{ ok: boolean; name: string }> {
  return apiRequest('/v1/lsp', {
    method: 'POST',
    body: { name: req.name, command: req.command, args: req.args, env: req.env },
  });
}

export function removeLspServer(name: string): Promise<{ ok: boolean; name: string }> {
  return apiRequest('/v1/lsp/remove', { method: 'POST', body: { name } });
}

export function checkLspCommand(command: string): Promise<Api.LspCheckResult> {
  return apiRequest('/v1/lsp/check', { method: 'POST', body: { command } });
}

// workspace 语言统计:按扩展名聚合源文件数(会话界面 LSP 检测提示用)
export function getWorkspaceLanguages(workspaceId: string): Promise<Api.WorkspaceLanguages> {
  return apiRequest(`/v1/workspaces/${workspaceId}/languages`);
}

// LSP 一键安装:后台执行安装命令,成功后自动写 [lsp.<lang>] 配置
export function listLspPlans(): Promise<Api.LspInstallPlan[]> {
  return apiRequest('/v1/lsp/plans');
}

export function installLspServer(
  name: string,
): Promise<{ ok: boolean; name: string; command?: string }> {
  return apiRequest('/v1/lsp/install', { method: 'POST', body: { name } });
}

export function getLspInstallStatus(): Promise<Api.LspInstallStatus> {
  return apiRequest('/v1/lsp/install/status');
}

export function cancelLspInstall(): Promise<{ ok: boolean }> {
  return apiRequest('/v1/lsp/install/cancel', { method: 'POST' });
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

/** 设置/清除某模型的上下文窗口覆盖(写入 combo-cli 配置,压缩预算与用量展示共用)。 */
export function setGlobalModelContextWindow(
  req: { providerId: string; modelId: string; contextWindow?: number },
): Promise<{ ok: boolean }> {
  return apiRequest('/v1/providers/context-window', {
    method: 'POST',
    body: {
      provider_id: req.providerId,
      model_id: req.modelId,
      context_window: req.contextWindow ?? null,
    },
  });
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

export interface LanInfo {
  /** 局域网直连候选地址(空 = 不可用) */
  urls: string[];
  port: number;
  lan_listening: boolean;
  has_static: boolean;
}

export interface P2pStatus {
  enabled: boolean;
  connected: number;
}

/** 查询局域网直连信息(桌面端生成二维码时调用)。 */
export function getLanInfo(): Promise<LanInfo> {
  return apiRequest('/v1/lan-info');
}

/** 查询 WebRTC P2P 直连状态。 */
export function getP2pStatus(): Promise<P2pStatus> {
  return apiRequest('/v1/p2p/status');
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
  /** 单独使用的模型;null = 跟随目标项目默认(清除已保存的)。 */
  model?: Api.AutomationModel | null;
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

// ---------- 知识图谱 ----------

/** 获取项目的知识图谱(文件级依赖图 + 外部依赖统计)。 */
export function getWorkspaceGraph(workspaceId: string): Promise<Api.WorkspaceGraph> {
  return apiRequest(`/v1/workspaces/${workspaceId}/graph`);
}

// ---------- 本地语音识别(ASR,中文 SenseVoice / Moonshine 中英) ----------

/** 查询语音模型状态(未就绪/下载中/加载中/就绪/失败)。 */
export function getTranscribeStatus(): Promise<Api.TranscribeStatus> {
  return apiRequest('/v1/transcribe/status');
}

/** 触发语音模型下载/加载(幂等,后台执行)。 */
export function prepareTranscribe(): Promise<{ ok: boolean; phase: Api.TranscribePhase }> {
  return apiRequest('/v1/transcribe/prepare', { method: 'POST' });
}

/**
 * 切换语音识别模型并持久化到配置(`[asr] model`)。
 * `model` 取值:`sense-voice`(中文)/ `moonshine-zh`(中文)/ `moonshine-en`(英文);
 * 切换后回到未就绪状态,首次使用自动下载对应模型。
 */
export function setTranscribeModel(model: string): Promise<Api.TranscribeModelResult> {
  return apiRequest('/v1/transcribe/model', {
    method: 'POST',
    body: { model },
  });
}

/**
 * 转写 16kHz 单声道 PCM16 音频(原始二进制请求体)。
 * 模型未就绪时抛出 code 为 `asr_not_ready` 的 ApiError(503)。
 */
export function transcribeAudio(pcm: ArrayBuffer): Promise<Api.TranscribeResult> {
  return apiRequestRaw('/v1/transcribe', {
    method: 'POST',
    query: { sample_rate: '16000' },
    body: pcm,
    contentType: 'application/octet-stream',
    timeoutMs: 120_000,
  });
}

// ---------- 本地语音合成(TTS,piper 中文 / HF 高质量) ----------

/** 查询语音朗读状态(开关 + 模型 + 下载/加载进度)。 */
export function getSpeechStatus(): Promise<Api.SpeechStatus> {
  return apiRequest('/v1/speech/status');
}

/** 触发语音模型下载/加载(幂等,后台执行,立即返回)。 */
export function prepareSpeech(): Promise<{ ok: boolean; phase: Api.TranscribePhase }> {
  return apiRequest('/v1/speech/prepare', { method: 'POST' });
}

/**
 * 设置朗读语速倍率(0.5~2.0,1.0 为正常语速),持久化到配置 `[tts] speed`。
 */
export function setSpeechSpeed(speed: number): Promise<Api.SpeechSpeedResult> {
  return apiRequest('/v1/speech/speed', { method: 'POST', body: { speed } });
}

/** 打开/关闭语音朗读并持久化到配置(`[tts] enabled`)。 */
export function setSpeechEnabled(enabled: boolean): Promise<Api.SpeechConfigResult> {
  return apiRequest('/v1/speech/config', { method: 'POST', body: { enabled } });
}

/**
 * 切换语音朗读模型并持久化到配置(`[tts] model`)。
 * `model` 取值:`piper-zh-xiaoya`(中文女声)/ `piper-zh-chaowen`(中文男声)/ `vits-zh-fanchen-c`(高质量)/ `vits-zh-en-melo`(中英双语);
 * 切换后回到未就绪状态,首次合成自动下载。
 */
export function setSpeechModel(model: string): Promise<Api.SpeechModelResult> {
  return apiRequest('/v1/speech/model', { method: 'POST', body: { model } });
}

/**
 * 合成单句文本为 WAV(ArrayBuffer 响应)。
 * 关闭时抛 code 为 `tts_disabled` 的 ApiError(400);模型未就绪抛 `tts_not_ready`(503)。
 * 传 AbortSignal 可取消(打断朗读)。
 */
export function synthesizeSpeech(text: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  return apiRequestBinary('/v1/speech', {
    method: 'POST',
    body: { text },
    signal,
    timeoutMs: 30_000,
  });
}

/**
 * 试听模型音色:合成单句文本为 WAV(ArrayBuffer 响应),不要求朗读开关打开。
 * 模型未就绪抛 code 为 `tts_not_ready` 的 ApiError(503)。
 */
export function synthesizeSpeechTest(text: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  return apiRequestBinary('/v1/speech/test', {
    method: 'POST',
    body: { text },
    signal,
    timeoutMs: 30_000,
  });
}

/** 流式合成的一行(chunk 携带 base64 编码的 PCM16LE 单声道音频)。 */
export interface SpeechStreamChunkLine {
  type: 'chunk';
  seq: number;
  /** 是否句末边界(硬边界停顿略长于逗号等软边界,由调用方排期控制)。 */
  hard: boolean;
  sample_rate: number;
  pcm: string;
}
export type SpeechStreamLine =
  | SpeechStreamChunkLine
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * 流式合成语音(POST /v1/speech/stream,NDJSON):服务端把文本切成片段
 * (句末/逗号边界)逐个合成,每个片段合成完立即回调 onChunk(pcm 为
 * PCM16LE 单声道字节,经 `pcm16ToAudioBuffer` 解码即可排期播放)——
 * 后续片段在前一段播放期间继续合成,句间无「等合成」空档;片段首尾静音
 * 已由服务端裁剪,停顿时长由调用方的短间隙控制。
 *
 * `test=true` 不要求朗读开关打开(设置区试听/通知语音播报使用)。
 * 模型未就绪抛 code 为 `tts_not_ready` 的 ApiError(503),调用方等待就绪后
 * 重试(见 `waitSpeechModelReady`);流中失败以 ApiError(500) 抛出。
 * 返回收到的 chunk 数(0 表示文本无可读内容)。
 */
export async function streamSpeech(
  text: string,
  opts: {
    test?: boolean;
    signal?: AbortSignal;
    onChunk: (pcm: ArrayBuffer, sampleRate: number, hard: boolean) => void;
  }
): Promise<number> {
  let chunks = 0;
  await apiRequestNdjson('/v1/speech/stream', {
    body: { text, test: opts.test ?? false },
    signal: opts.signal,
    onLine: (line) => {
      const l = line as SpeechStreamLine;
      if (l?.type === 'chunk' && typeof l.pcm === 'string') {
        const bytes = decodeBase64(l.pcm);
        if (bytes.byteLength > 0) {
          chunks += 1;
          opts.onChunk(bytes.buffer as ArrayBuffer, l.sample_rate, Boolean(l.hard));
        }
      } else if (l?.type === 'error') {
        throw new ApiError(500, l.message || '语音合成失败');
      }
    },
  });
  return chunks;
}

