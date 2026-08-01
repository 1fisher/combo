export const PAYLOAD_TYPES = [
  'lsp_event',
  'mcp_event',
  'permission_request',
  'permission_notification',
  'message',
  'session',
  'file',
  'agent_event',
  'config_changed',
  'skills_event',
  'run_complete',
  'update_available',
  'question_batch_request',
  'question_batch_notification',
] as const;
export type PayloadType = (typeof PAYLOAD_TYPES)[number];

export interface EventEnvelope {
  type: PayloadType;
  payload: unknown;
}
