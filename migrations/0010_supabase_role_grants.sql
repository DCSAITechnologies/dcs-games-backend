-- ============================================================================
-- 0010 — grant the Supabase roles what they actually need, and nothing else
--
-- Found by applying this chain to a real dedicated Supabase project for the
-- first time. Every table was created correctly, RLS came out enabled, and the
-- Data API could not read a single row — as SERVICE_ROLE, not merely as anon:
--
--   GET /rest/v1/dcsgames_base_worlds  (service_role)
--     403 {"code":"42501","message":"permission denied for table dcsgames_base_worlds"}
--
-- The cause is that the roles held only REFERENCES, TRIGGER and TRUNCATE on
-- these tables — no SELECT, INSERT, UPDATE or DELETE. Nothing in the chain ever
-- granted DML, because until now the chain had only ever been applied to plain
-- Postgres, where the backend connects as the owner and the question never
-- arises. On Supabase the backend goes through PostgREST as service_role, so
-- the whole Supabase-backed persistence layer would have silently run degraded
-- — file-only — against a correctly configured database.
--
-- WHO GETS WHAT, and why:
--
--   service_role   full DML. This is the BACKEND's identity. It is a
--                  server-side-only credential, it bypasses RLS by design, and
--                  every authorisation decision on this estate is made in the
--                  application layer above it (ownership, membership, the
--                  internal-tester window, the money-dark rules).
--
--   anon           NOTHING. Deliberately.
--   authenticated  NOTHING. Deliberately.
--
-- That second decision is the important one. A typical Supabase application
-- lets the browser talk to PostgREST directly and defends itself with RLS
-- policies. This estate does not: the frontend calls the DCS Games API, which
-- authenticates through src/core/principal.mjs and answers with the same
-- refusals whether or not a row exists. Granting the browser roles direct table
-- access would create a SECOND, policy-shaped authorisation surface beside the
-- one that is already tested — and this sprint's history is largely a record of
-- what happens when the same question gets two answers. So they get none, and
-- RLS-with-no-policies remains a second lock behind the missing grant.
--
-- Portable by construction: plain Postgres has no `service_role`, so the whole
-- block is a no-op there and `node scripts/migrate.mjs` still works locally.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage on schema public to service_role;
    grant select, insert, update, delete on all tables in schema public to service_role;
    grant usage, select on all sequences in schema public to service_role;

    -- Tables added by a LATER migration must not have to remember this.
    alter default privileges in schema public
      grant select, insert, update, delete on tables to service_role;
    alter default privileges in schema public
      grant usage, select on sequences to service_role;
  end if;

  -- anon and authenticated are named here only to say, in the schema itself,
  -- that their absence is a decision rather than an oversight.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon;
    revoke all on all tables in schema public from authenticated;
  end if;
end $$;

-- PostgREST caches the schema. Without this, tables created by a migration stay
-- invisible to the Data API until the next reload, which looks exactly like a
-- missing table.
do $$
begin
  if exists (select 1 from pg_catalog.pg_channel where false) then null; end if;
exception when others then null;
end $$;
notify pgrst, 'reload schema';
