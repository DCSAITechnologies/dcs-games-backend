-- ============================================================================
-- 0003 — durable world manifests (A3) and the constraints A2 found missing
--
-- The running service wrote to dcsgames_base_worlds, a table the 0001 baseline
-- never declared: production schema and code had drifted. This migration
-- reconciles them, and adds the uniqueness/idempotency constraints whose absence
-- allowed the same world to be inserted twice.
-- ============================================================================

create table if not exists public.dcsgames_base_worlds (
  world_id         text        primary key,          -- generator-issued id, not a uuid
  owner_id         text,                             -- auth principal id (uuid text in supabase mode)
  title            text,
  state            text        not null default 'draft'
                     check (state in ('draft','published','archived')),
  version          integer     not null default 1,   -- monotonic per world
  manifest         jsonb       not null,             -- LOSSLESS WorldManifestV3 (or v1 runtime world)
  manifest_hash    text        not null,             -- sha256 over the canonicalised manifest
  manifest_version text,                             -- e.g. '3.0.0'
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Idempotency: the same content under the same id must never create a second row.
create unique index if not exists dcsgames_base_worlds_id_uq
  on public.dcsgames_base_worlds(world_id);

create index if not exists dcsgames_base_worlds_owner_idx
  on public.dcsgames_base_worlds(owner_id, updated_at desc);

create index if not exists dcsgames_base_worlds_state_idx
  on public.dcsgames_base_worlds(state, updated_at desc);

create index if not exists dcsgames_base_worlds_hash_idx
  on public.dcsgames_base_worlds(manifest_hash);

-- Version history: every accepted world version is retained so an expansion can
-- be rolled back to the exact manifest it replaced (B6 rollback requirement).
create table if not exists public.dcsgames_world_versions (
  world_id      text        not null,
  version       integer     not null,
  manifest      jsonb       not null,
  manifest_hash text        not null,
  label         text,                                -- e.g. 'V2 hospital district'
  created_by    text,
  created_at    timestamptz not null default now(),
  primary key (world_id, version)
);

create index if not exists dcsgames_world_versions_world_idx
  on public.dcsgames_world_versions(world_id, version desc);

-- Recorded world chronology (B7). Facts only: NPCs and the companion may cite
-- these rows, and nothing else, so "memory" can never be invented.
create table if not exists public.dcsgames_world_events (
  id           bigserial   primary key,
  world_id     text        not null,
  world_version integer,
  kind         text        not null
                 check (kind in ('created','expanded','edited','published','player_event','seasonal','milestone','rollback')),
  summary      text        not null,
  detail       jsonb,
  actor_id     text,
  occurred_at  timestamptz not null default now()
);

create index if not exists dcsgames_world_events_world_idx
  on public.dcsgames_world_events(world_id, occurred_at desc);

-- Idempotency keys for any write that a client may safely retry.
create table if not exists public.dcsgames_idempotency (
  key         text        primary key,
  route       text        not null,
  principal_id text,
  response    jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists dcsgames_idempotency_created_idx
  on public.dcsgames_idempotency(created_at);

-- updated_at must never be stale.
create or replace function public.dcsgames_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists dcsgames_base_worlds_touch on public.dcsgames_base_worlds;
create trigger dcsgames_base_worlds_touch
  before update on public.dcsgames_base_worlds
  for each row execute function public.dcsgames_touch_updated_at();
