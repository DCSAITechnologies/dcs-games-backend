-- ============================================================================
-- PROPOSED — NOT APPLIED. NOT IN migrations/. Lead/founder review required.
-- 0014 — World Memory v2 (GAMES-C Agent 2): hash-chained versions, patches,
--        per-player resume state, companion context, generation provenance,
--        asset identities, expansion lineage.
--
-- Principle: EXTEND schema v13, do not duplicate it.
--   * dcsgames_world_versions (0003) stays THE version table. It gains the chain
--     columns; every existing column and the (world_id, version) PK are kept, so
--     WorldRepository / SupabaseVersionHistoryStore keep working unchanged.
--     `manifest` stays NOT NULL in phase 1: every Supabase row keeps a full
--     manifest (i.e. every row is a snapshot). Snapshot-every-K is used by the
--     file/in-memory adapters only until phase 2 drops NOT NULL.
--   * dcsgames_base_worlds (0003) stays the "current world" row (head).
--   * dcsgames_world_events (0003) stays the B7 fact chronicle.
--   * dcsgames_world_deltas / dcsgames_world_snapshots (0009) are the CW5
--     RUNTIME op log (object positions/ownership), a different concept; untouched.
-- Idempotent: every statement is IF NOT EXISTS / guarded.
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
-- 'rollback'. Harmless today (the chronicle is file-backed), fatal the day it is
-- written to Postgres. Proposed fix:
-- alter table public.dcsgames_world_events drop constraint if exists dcsgames_world_events_kind_check;
-- alter table public.dcsgames_world_events add constraint dcsgames_world_events_kind_check
--   check (kind in ('created','expanded','edited','published','player_event','seasonal','milestone','rollback','rolled_back'));

-- RLS: none of these tables should be readable with the anon key; server-side
-- service role only, matching 0010_supabase_role_grants.sql conventions.
