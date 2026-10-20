<!-- title: <type>: <short summary>, e.g. fix: re-arm recurring jobs -->

## Summary

What does this PR change and why? Reference any related issue
(`closes #123`).

## Changes

- 

## Tests

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run test:unit` (or full `npm test` with `ORBIT_TEST_DATABASE_URL`)

## Checklist

- [ ] Tenant scoping preserved: user triggered tenant table access goes
      through `TenantService` / `withTenant` only
- [ ] No fabricated data: unknown fields stay `null`
- [ ] Secrets: nothing new in `.env.example` beyond placeholders
- [ ] Docs updated (no em dashes; plain ASCII embed copy)
- [ ] Schema changes: drizzle migration generated and `tenantTables` updated
      for new tenant tables
