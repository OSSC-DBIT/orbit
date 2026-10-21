import * as reference from "./reference.js";
import * as tenants from "./tenants.js";
import * as opportunitiesSchema from "./opportunities.js";

export { reference, tenants, opportunitiesSchema };

export const schema = {
  ...reference,
  ...tenants,
  ...opportunitiesSchema,
};

// Re-export every table + helper by name so imports like
// `import { opportunities } from "../schema/index.js"` work directly.
export * from "./reference.js";
export * from "./tenants.js";
export * from "./opportunities.js";

/** Tables carrying tenant data (`guild_id` column) — RLS is applied to these. */
export const tenantTables: string[] = [
  "guild_feature_settings",
  "guild_channels",
  "guild_preferences",
  "guild_authorized_roles",
  "opportunity_deliveries",
  "deadline_notifications",
  "audit_logs",
  "infrastructure_hosts",
  "infra_events",
];

/**
 * SQL fragments enabling RLS + tenant-isolation policies on tenant tables.
 * The application sets `app.guild_id` (a GUC) per transaction; the pooled
 * connection cannot leak it because the value is cleared at commit when set
 * with `set_config(..., true)` (transaction-local).
 *
 * The sentinel value 'no-tenant' matches nothing, so role-based access and
 * system jobs that legitimately need cross-tenant scope must run through the
 * explicitly granted `orbit_service` role or set the GUC via
 * `set_config('app.guild_id', guildId, true)`.
 */
export function tenantRlsStatements(): string[] {
  const statements: string[] = [];
  for (const table of tenantTables) {
    statements.push(
      `alter table ${table} enable row level security;`,
      `alter table ${table} force row level security;`,
      `drop policy if exists tenant_isolation_${table} on ${table};`,
      `create policy tenant_isolation_${table} on ${table}
         using (
           guild_id = coalesce(nullif(current_setting('app.guild_id', true), ''), '__no_tenant__')
           or current_setting('app.guild_id', true) = '__system__'
         )
         with check (
           guild_id = coalesce(nullif(current_setting('app.guild_id', true), ''), '__no_tenant__')
           or current_setting('app.guild_id', true) = '__system__'
         );`,
    );
  }
  return statements;
}
