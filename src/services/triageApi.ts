/**
 * Client for the UrbanFix agent API (LangGraph: Laya labels -> main agent -> 4 sub-agents
 * -> main agent's final answer).
 *
 * Start the service with:  npm run agents:api   (uvicorn agents.server:app --port 8010)
 * Override the host with   VITE_TRIAGE_API_URL   (defaults to http://localhost:8010)
 *
 * Port 8010 is used because 8000 is already taken by the user's laya_local_server.py.
 * Every call is optional by design: if the service is down the UI keeps its local keyword
 * inference instead of breaking.
 */
import type { Department } from '../types';

const BASE: string =
  (import.meta.env.VITE_TRIAGE_API_URL as string | undefined) ?? 'http://localhost:8010';

export type Priority = 'P1' | 'P2' | 'P3';

/** Layer-1 output of the local Laya checkpoint. */
export interface LabelResult {
  text: string;
  department: Department;
  dept_label: string;
  category: string;
  department_confidence: number;
  probabilities: Record<string, number>;
  severity_score: number;
  priority: Priority;
  sla_hours: number;
  urgent_probability: number;
  label_ms: number;
  source: 'laya' | 'keyword-fallback';
}

/** Full graph output. The flat fields are what the UI consumes. */
export interface TriageResult {
  route: Department;
  department: Department;
  deptLabel: string;
  category: string;
  defectType: string;
  priority: Priority;
  slaHours: number;
  title: string | null;
  confidence: number;
  labelSource: 'laya' | 'keyword-fallback';
  routingReason: string | null;
  dispatchBrief: string | null;
  escalationNotes: string | null;
  citizenReply: string | null;
  requiredCrew: string | null;
  labels: LabelResult;
  subAgent: Record<string, unknown>;
  final: Record<string, unknown>;
  trace: string[];
  elapsedMs: number;
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Layer-1 only: local Laya labelling, ~2 s, no LLM cost. */
export function labelTicket(text: string, meta: Record<string, unknown> = {}): Promise<LabelResult> {
  return post<LabelResult>('/api/label', { text, meta }, 30_000);
}

/** Full graph run: label -> route -> sub-agent -> main agent's final answer. */
export function triageTicket(text: string, meta: Record<string, unknown> = {}): Promise<TriageResult> {
  return post<TriageResult>('/api/triage', { text, meta }, 90_000);
}

/** Service probe used to show whether the agent API is online. */
export async function triageHealth(timeoutMs = 3_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const TRIAGE_API_URL = BASE;

/** Maps the main agent's priority onto the Ticket status/badge the dashboard already renders. */
export const PRIORITY_TICKET_STYLE: Record<
  Priority,
  { status: 'critical' | 'assigned' | 'pending'; statusLabel: string; badgeClass: string }
> = {
  P1: {
    status: 'critical',
    statusLabel: 'P1 Critical Hazard',
    badgeClass: 'bg-[#ffdbcf] text-[#370e01] border border-[#ffb59c]/50',
  },
  P2: {
    status: 'assigned',
    statusLabel: 'P2 Moderate Priority',
    badgeClass: 'bg-[#fff3cf] text-[#4a3200] border border-[#f3d98a]/60',
  },
  P3: {
    status: 'pending',
    statusLabel: 'P3 Routine Priority',
    badgeClass: 'bg-[#e3e8e4] text-[#31413a] border border-[#c2c8c2]/60',
  },
};
