/**
 * In-process metrics registry (Prometheus text export).
 * Kept dependency-light and safe to render from any endpoint.
 */
export interface MetricKey {
  name: string;
  labels?: Record<string, string>;
}

const counters = new Map<string, number>();
const gauges = new Map<string, number>();

function key({ name, labels }: MetricKey): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const labelStr = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(",");
  return `${name}{${labelStr}}`;
}

export function incr(name: string, labels?: Record<string, string>): void {
  const k = key({ name, labels });
  counters.set(k, (counters.get(k) ?? 0) + 1);
}

export function gauge(name: string, value: number, labels?: Record<string, string>): void {
  gauges.set(key({ name, labels }), value);
}

export function snapshot(): { counters: Array<[string, number]>; gauges: Array<[string, number]> } {
  return { counters: [...counters.entries()], gauges: [...gauges.entries()] };
}

/** Prometheus text exposition format. */
export function toPrometheusText(): string {
  const lines: string[] = [];
  for (const [k, v] of counters) lines.push(`${stripLabels(k)} ${v}`);
  for (const [k, v] of gauges) lines.push(`${stripLabels(k)} ${v}`);
  lines.push("orbit_process_up 1");
  return lines.join("\n") + "\n";
}

function stripLabels(series: string): string {
  // export with labels intact; Prometheus accepts `name{labels} value`
  const m = /^([\w:.-]+)(\{.*\})?$/.exec(series);
  if (!m) return `${series} 0`;
  return `${m[1]}${m[2] ?? ""} `;
}

const STATUS_LABEL = "status";

/** Standard counters for this app. */
export const metrics = {
  jobsOutcome: (jobType: string, outcome: string) => incr("orbit_jobs_total", { job: jobType, [STATUS_LABEL]: outcome }),
  deliveries: (kind: string, outcome: string) => incr("orbit_deliveries_total", { kind, [STATUS_LABEL]: outcome }),
  opportunityCreated: (sourceId: string) => incr("orbit_opportunities_total", { source: sourceId, [STATUS_LABEL]: "created" }),
  sourceRuns: (outcome: string) => incr("orbit_source_sync_total", { [STATUS_LABEL]: outcome }),
};
