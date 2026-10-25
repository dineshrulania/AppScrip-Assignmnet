export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

export interface Device {
  id: string;
  name: string;
  location: string;
  type: string;
  created_at: number;
  last_seen_at: number | null;
  last_event_ts: number | null;
  last_seq: number | null;
  boot_id: string | null;
  status: 'online' | 'offline' | 'unknown';
  status_since: number | null;
  latest: Record<string, { v: number; ts: number }>;
  events_total: number;
  duplicates_total: number;
  late_total: number;
  active_incidents?: number;
}

export interface FleetEvent {
  id: number;
  device_id: string;
  event_id: string;
  seq: number | null;
  type: string;
  ts: number;
  received_at: number;
  payload: Record<string, unknown>;
  late: boolean;
  out_of_order: boolean;
  status: 'pending' | 'processing' | 'processed' | 'failed';
  attempts?: number;
  last_error?: string | null;
  outcomes?: { rule_id: number; outcome: string; incident_id?: number }[];
}

export interface Incident {
  id: number;
  rule_id: number;
  device_id: string;
  status: IncidentStatus;
  severity: Severity;
  title: string;
  summary: string;
  opened_at: number;
  last_triggered_at: number;
  trigger_count: number;
  condition_active: number;
  detected_late: number;
  acknowledged_at: number | null;
  acknowledged_by: string | null;
  resolved_at: number | null;
  resolved_by: string | null;
  resolution_note: string | null;
  assignee: string | null;
  version: number;
  rule_name: string;
  rule_kind: string;
  device_name: string;
  location: string;
  device_type: string;
  event_count: number;
}

export interface Rule {
  id: number;
  name: string;
  kind: 'threshold' | 'absence' | 'event_type';
  enabled: boolean;
  severity: Severity;
  config: any;
  scope: { device_types?: string[]; locations?: string[]; device_ids?: string[] };
  cooldown_sec: number;
  auto_resolve: boolean;
  matches_1h?: number;
  last_match?: number | null;
  active_incidents?: number;
}

export interface Stats {
  at: number;
  devices: { total: number; online: number; offline: number };
  events_last_min: { accepted: number; duplicates: number; rejected: number; late: number };
  events_total: { accepted: number; duplicates: number; rejected: number; late: number };
  queue: { depth: number; pending: number; processing: number; dead_letter: number; oldest_age_ms: number; high_watermark: number };
  processing_lag_ms: { p50: number; p95: number; max: number; samples: number };
  incidents: { open: number; acknowledged: number; resolved: number; active_by_severity: Record<Severity, number>; mtta_ms: number | null };
  notifications: { pending: number; sent: number; dead: number };
}

export interface SeriesPoint {
  t: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  late: number;
}

export interface Operator {
  id: string;
  name: string;
  email: string;
  locations: string[];
  min_severity: Severity;
}
