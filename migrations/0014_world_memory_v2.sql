-- ============================================================================
-- 0014 — World Memory v2: hash-chained versions, patches, per-player resume
--        state, companion context, generation provenance, asset identities,
--        expansion lineage. Promoted from
--        docs/games-c/proposed-migrations/0014_world_memory_v2.PROPOSED.sql
--        (GAMES-C, 28 Sep 2026) by the Games-B backend closure, 30 Sep 2026.
--
-- ADDITIVE. No existing row is rewritten and no existing column changes type:
--   * dcsgames_world_versions (0003) gains NULLABLE chain columns (or columns
--     with a constant default), two CHECKs that every existing row satisfies
--     (both accept NULL), a partial unique index over rows that have a
--     version_hash (none do yet), and an insert-only trigger.
--   * seven new tables, empty.
--   * the dcsgames_world_events kind CHECK is WIDENED to a superset (adds
--     'rolled_back', which src/v3/memory/world-memory.mjs already emits).
--
-- THE TRIGGER, read before applying. Versions become insert-only at the
-- database: UPDATE and DELETE on dcsgames_world_versions raise. The only
-- writer (SupabaseVersionHistoryStore.put) is already a plain INSERT that
-- treats 23505 as success, so nothing in src/ is affected. What IS affected is
-- a manual purge (for example a data-subject erasure): it must run as a
-- deliberate, reviewed statement with the trigger disabled for that session
--   (alter table ... disable trigger dcsgames_world_versions_no_update)
-- rather than as a casual DELETE. TRUNCATE does not fire row triggers.
--
-- Idempotent: every statement is IF NOT EXISTS / guarded, so a re-run after a
-- partial manual apply is safe. migrate() wraps this file in one transaction.
-- ============================================================================

-- 1. Chain columns on the existing version table ------------------------------
alter table public.dcsgames_world_versions
  add column if not exists memory_version text,
  add column if not exists parent_version integer,
  add column if not exists parent_hash    text,                 -- previous row's version_hash (null for v1)
  add column if not exists version_hash   text,                 -- H([parent_hash, manifest_hash, patch_ids])
  add column if not exists record_hash    text,                 -- digest over the whole record (metadata tamper)
  add column if not exists kind           text,                 -- save|edit|restore|expand|fork
  add column if not exists patch_ids      jsonb not null default '[]'::jsonb,
  add column if not exists patch_hashes   jsonb not null default '[]'::jsonb,
  add column if not exists snapshot       boolean not null default true,
  add column if not exists restored_from  integer,
  add column if not exists spec_hash      text,
  add column if not exists lineage        jsonb,                -- {parent_world_id, parent_version, parent_version_hash, kind}
  add column if not exists author         jsonb,                -- {kind:user|companion|system, id}
  -- The known gap documented in worldstore.mjs (SupabaseVersionHistoryStore):
  -- the version's publication state has no column, so after disk loss a
  -- stranger sees no history. Adding it closes that gap as a side effect.
  add column if not exists state          text;

do $$ begin
  alter table public.dcsgames_world_versions
    add constraint dcsgames_world_versions_kind_ck
    check (kind is null or kind in ('save','edit','restore','expand','fork'));
exception when duplicate_object then null; end $$;

-- Monotonic, contiguous parent pointer (legacy rows have null parent_version).
do $$ begin
  alter table public.dcsgames_world_versions
    add constraint dcsgames_world_versions_parent_ck
    check (parent_version is null or parent_version = version - 1);
exception when duplicate_object then null; end $$;

create unique index if not exists dcsgames_world_versions_vhash_uq
  on public.dcsgames_world_versions(world_id, version_hash) where version_hash is not null;

-- Immutability: versions are insert-only (the file store already refuses overwrite).
-- See the header: a sanctioned purge disables this trigger for its own session.
create or replace function public.dcsgames_world_versions_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'dcsgames_world_versions rows are immutable (world %, v%)', old.world_id, old.version;
end $$;
drop trigger if exists dcsgames_world_versions_no_update on public.dcsgames_world_versions;
create trigger dcsgames_world_versions_no_update
  before update or delete on public.dcsgames_world_versions
  for each row execute function public.dcsgames_world_versions_immutable();

-- 2. Patches (edit history bodies + inverses) --------------------------------
create table if not exists public.dcsgames_world_patches (
  world_id    text        not null,
  patch_id    text        not null,
  version     integer     not null,                 -- the version this patch produced
  patch       jsonb       not null,                 -- full patch per docs/games-c/DCS_GAMES_EDIT_PATCH_SCHEMA.md
  patch_hash  text        not null,
  inverse     jsonb,
  author      jsonb,
  created_at  timestamptz not null default now(),
  primary key (world_id, patch_id)
);
create index if not exists dcsgames_world_patches_version_idx on public.dcsgames_world_patches(world_id, version);

-- 3. Content-addressed snapshots (phase 2, when versions drop manifest NOT NULL)
create table if not exists public.dcsgames_world_manifest_snapshots (
  world_id      text        not null,
  manifest_hash text        not null,
  manifest      jsonb       not null,
  created_at    timestamptz not null default now(),
  primary key (world_id, manifest_hash)
);

-- 4. Game spec, content-addressed ---------------------------------------------
create table if not exists public.dcsgames_world_specs (
  world_id   text        not null,
  spec_hash  text        not null,
  spec       jsonb       not null,
  created_at timestamptz not null default now(),
  primary key (world_id, spec_hash)
);

-- 5. Per-player resume state (NOT rollback evidence; see playerprogress.mjs) --
create table if not exists public.dcsgames_world_player_state (
  world_id    text        not null,
  player_id   text        not null,
  rev         integer     not null,                 -- optimistic concurrency
  at_version  integer,
  source      text        not null default 'client_reported'
                check (source in ('client_reported','server_authoritative')),
  data        jsonb       not null,                 -- {position, inventory, progress, ...}; app caps 32 KiB
  updated_at  timestamptz not null default now(),
  primary key (world_id, player_id)
);

-- 6. Companion context (opaque blob from the companion module) ----------------
create table if not exists public.dcsgames_world_companion_context (
  world_id     text        not null,
  scope        text        not null,                -- player id, or 'world'
  rev          integer     not null,
  at_version   integer,
  context_hash text        not null,
  data         jsonb       not null,                -- app caps 64 KiB
  updated_at   timestamptz not null default now(),
  primary key (world_id, scope)
);

-- 7. Bounded logs: edit history summaries + generation provenance -------------
create table if not exists public.dcsgames_world_memory_log (
  world_id   text        not null,
  log        text        not null check (log in ('edit_history','generation_history')),
  seq        bigint      not null,
  entry      jsonb       not null,
  created_at timestamptz not null default now(),
  primary key (world_id, log, seq)
);
-- Bounding is done by the application (keep newest N) or a scheduled prune.

-- 8. Asset identity map (content hash -> identity; asset id -> history) -------
create table if not exists public.dcsgames_world_asset_identities (
  world_id      text        not null,
  content_hash  text        not null,
  identity      text        not null,               -- 'asset_' || first 16 hex of content_hash
  first_version integer     not null,
  asset_ids     jsonb       not null default '[]'::jsonb,
  primary key (world_id, content_hash)
);

-- 9. Expansion / fork lineage DAG ---------------------------------------------
create table if not exists public.dcsgames_world_lineage (
  id                  bigserial   primary key,
  kind                text        not null,          -- expand_area | fork | stitch | ...
  from_world_id       text        not null,
  from_version        integer     not null,
  from_version_hash   text        not null,
  to_world_id         text        not null,
  to_version          integer     not null,
  to_version_hash     text        not null,
  area_id             text,
  label               text,
  author              jsonb,
  created_at          timestamptz not null default now(),
  unique (to_world_id, to_version)
);
create index if not exists dcsgames_world_lineage_from_idx on public.dcsgames_world_lineage(from_world_id);
create index if not exists dcsgames_world_lineage_to_idx   on public.dcsgames_world_lineage(to_world_id);

-- 10. Pre-existing gap found while mapping (independent of v2) -----------------
-- world-memory.mjs emits kind 'rolled_back' but the 0003 CHECK lists only
-- 'rollback': harmless while the chronicle is file-backed, and the first
-- Postgres write of a rollback would fail. Widened to a superset; every
-- existing row still satisfies it.
alter table public.dcsgames_world_events drop constraint if exists dcsgames_world_events_kind_check;
alter table public.dcsgames_world_events add constraint dcsgames_world_events_kind_check
  check (kind in ('created','expanded','edited','published','player_event','seasonal','milestone','rollback','rolled_back'));

-- 11. Access. Server-side service role only, per 0010: the browser roles get
-- nothing, and RLS with no policies is the second lock behind the missing
-- grant. 0010's default privileges already give service_role DML on new
-- tables; they are restated so this file does not depend on 0010's defaults
-- having been in force when these tables were created.
do $$
declare t text;
begin
  foreach t in array array[
    'dcsgames_world_patches','dcsgames_world_manifest_snapshots','dcsgames_world_specs',
    'dcsgames_world_player_state','dcsgames_world_companion_context','dcsgames_world_memory_log',
    'dcsgames_world_asset_identities','dcsgames_world_lineage']
  loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant select, insert, update, delete on public.%I to service_role', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on public.%I from authenticated', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant usage, select on sequence public.dcsgames_world_lineage_id_seq to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
