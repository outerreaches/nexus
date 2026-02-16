import type { AgentRunInfo } from "../../core/agent-tracker.js";
import type { ManagedProcessInfo } from "../../process/manager.js";

export type { AgentRunInfo, ManagedProcessInfo };

export type JobRow = {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  consecutive_failures: number;
  last_failure_at: number | null;
  spec_json: string;
};

export type JobRunRow = {
  id: string;
  job_id: string;
  agent_id: string;
  scheduled_for: number;
  started_at: number;
  ended_at: number | null;
  status: string;
  error: string | null;
  tool_calls_used: number | null;
  iterations_used: number | null;
};

export type AgentRunRow = {
  run_id: string;
  parent_run_id: string | null;
  agent_id: string;
  preset: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  task: string | null;
};

export type NodeRow = {
  id: string;
  label: string;
  backend: string;
  status: string;
  trust_level: string;
  firewall_mode: string;
  endpoint: string | null;
  capabilities_json: string;
  tags_json: string;
  last_seen_at: number | null;
  connected_at: number | null;
  created_at: number;
  updated_at: number;
};

export type BlackboardRow = {
  id: string;
  session_scope: string;
  type: string;
  agent_id: string;
  agent_preset: string;
  title: string;
  content: string;
  created_at: number;
  expires_at: number | null;
};

export type DataIntakeRow = {
  source_id: string;
  source_name: string;
  tags_json: string;
  subject: string;
  value_json: string;
  collected_at: number;
  expires_at: number;
};

export type DataIntakePanelState = {
  enabled: boolean;
  targets: string[];
  rows: DataIntakeRow[];
  hideOrphans: boolean;
  sources: {
    id: string;
    source_id: string;
    label: string | null;
    params_json: string;
    interval_ms: number;
    enabled: number;
    last_run_at: number | null;
    last_error: string | null;
  }[];
};

export type DataIntakeCatalogEntry = {
  id: string;
  name: string;
  description: string;
  tags: string[];
};

export type HAEventRow = {
  id: string;
  event_type: string;
  source: string;
  from_instance: string | null;
  to_instance: string | null;
  details_json: string;
  created_at: number;
};

export type BackupRow = {
  id: string;
  filename: string;
  completed_at: number | null;
  size_bytes: number;
  status: string;
  backup_type: string;
};

export type LlmSessionRow = {
  id: string;
  channel: string;
  channel_key: string;
  agent_id: string;
  created_at: number;
  last_message_at: number;
  message_count: number;
};

export type LlmMessageRow = {
  id: number;
  session_id: string;
  role: string;
  content: string;
  name: string | null;
  tool_call_id: string | null;
  tool_calls_json: string | null;
  created_at: number;
};
