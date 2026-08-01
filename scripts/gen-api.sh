#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

npx openapi-typescript swagger/swagger.json \
  --output src/lib/api/types.ts \
  --export-type

cat >> src/lib/api/types.ts <<'EOF'

/**
 * Api namespace: accurate aliases for the rune (Crush) wire types used by
 * combo. The vendored swagger.json is incomplete (parts are typed as
 * unknown and question/part types are missing), so these are maintained
 * by hand against ../rune proto sources and verified by the contract test.
 */
export namespace Api {
  export type Error = { message: string };

  export type Workspace = {
    id: string;
    path: string;
    yolo?: boolean;
    debug?: boolean;
    data_dir?: string;
    version?: string;
    client_id?: string;
    channels?: string[];
  };

  export type Session = {
    id: string;
    parent_session_id?: string;
    title: string;
    message_count: number;
    prompt_tokens: number;
    completion_tokens: number;
    summary_message_id?: string;
    cost: number;
    todos?: { content: string; status: string; active_form: string }[];
    created_at: number;
    updated_at: number;
    is_busy?: boolean;
    attached_clients?: number;
  };

  export type MessageRole = 'assistant' | 'user' | 'system' | 'tool';

  export type ReasoningContent = {
    thinking: string;
    signature: string;
    started_at?: number;
    finished_at?: number;
  };
  export type TextContent = { text: string };
  export type ImageURLContent = { url: string; detail?: string };
  export type ToolCall = {
    id: string;
    name: string;
    input: string;
    type?: string;
    finished?: boolean;
  };
  export type ToolResult = {
    tool_call_id: string;
    name: string;
    content: string;
    data?: string;
    mime_type?: string;
    metadata?: string;
    is_error?: boolean;
  };
  export type FinishContent = {
    reason: string;
    time?: number;
    message?: string;
    details?: string;
  };

  export type ContentPart =
    | { type: 'reasoning'; data: ReasoningContent }
    | { type: 'text'; data: TextContent }
    | { type: 'image_url'; data: ImageURLContent }
    | { type: 'binary'; data: unknown }
    | { type: 'tool_call'; data: ToolCall }
    | { type: 'tool_result'; data: ToolResult }
    | { type: 'finish'; data: FinishContent }
    | { type: 'shell_command'; data: { command: string; output: string; exit_code: number } };

  export type Message = {
    id: string;
    role: MessageRole;
    session_id: string;
    parts: ContentPart[];
    model: string;
    provider: string;
    created_at: number;
    updated_at: number;
  };

  export type AgentMessage = {
    session_id: string;
    run_id?: string;
    prompt: string;
    attachments?: unknown[];
  };

  export type PermissionRequest = {
    id: string;
    session_id: string;
    tool_call_id: string;
    tool_name: string;
    description: string;
    action: string;
    params: unknown;
    path: string;
  };

  export type PermissionGrant = {
    permission: PermissionRequest;
    action: 'allow' | 'allow_session' | 'deny';
  };

  export type QuestionChoice = { id: string; label: string; description?: string };
  export type QuestionItem = {
    id: string;
    type: string;
    label?: string;
    question: string;
    description?: string;
    choices?: QuestionChoice[];
  };
  export type QuestionRequest = {
    id: string;
    session_id: string;
    tool_call_id: string;
    questions: QuestionItem[];
    confirm_title?: string;
    confirm_description?: string;
  };
  export type QuestionResponse = {
    request_id: string;
    selected_ids?: string[];
    fill_in_text?: string;
    yes?: boolean;
    notes?: Record<string, string>;
  };
  export type QuestionAnswer = {
    batch_request_id: string;
    responses: QuestionResponse[];
  };
}
EOF
