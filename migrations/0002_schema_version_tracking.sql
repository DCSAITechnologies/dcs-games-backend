-- ============================================================================
-- 0002 — schema version tracking
--
-- Round-2 found two divergent schema lineages and no way to tell which one a
-- running service was talking to. This table is the single answer to "what
-- schema is this database at", and the boot-time assertion in
-- src/core/schema.mjs refuses to start against a version it does not support.
--
-- NOTE: the number 0002 previously belonged to the forensic seed that inserted
-- invented creators with atlas_verified=true. That file is quarantined under
-- forensics/ in the lineage repo and is NOT part of this chain.
-- ============================================================================

create table if not exists public.dcsgames_schema_migrations (
  version      integer primary key,
  name         text        not null,
  checksum     text        not null,          -- sha256 of the migration body as applied
  applied_at   timestamptz not null default now(),
  applied_by   text        not null default current_user
);

comment on table public.dcsgames_schema_migrations is
  'Canonical migration ledger. One row per applied migration. Never edit an applied row; add a new migration instead.';

create or replace function public.dcsgames_schema_version()
returns integer language sql stable as $$
  select coalesce(max(version), 0) from public.dcsgames_schema_migrations;
$$;
