-- ============================================================================
-- 0009 — the CW5 runtime persistence tables
--
-- The CW5 Supabase store writes to three tables. TWO OF THEM HAVE NEVER
-- EXISTED in this chain — dcsgames_world_deltas and dcsgames_world_snapshots
-- appear in no migration — and the third, dcsgames_base_worlds, is a DIFFERENT
-- TABLE that already carries a different meaning: the v3 world store's records,
-- with `manifest` and `manifest_hash` and no `base` column at all.
--
-- So in the only configuration where the Supabase store is used — the deployed
-- one — every CW5 write answered 400 or 404. Nothing noticed, because every
-- test on this estate runs on the file/in-memory store, and because these
-- tables were not in REQUIRED_TABLES the boot-time schema assertion had nothing
-- to check.
--
-- That matters beyond CW5: livestate.mjs reads the CW5 snapshot as the evidence
-- for who owns which structure and who holds which item — the two live-state
-- categories reported as fully determined, and the ones a rollback consults
-- before deleting a player's property.
--
-- Two concepts sharing one name is the underlying defect, so CW5's base world
-- gets its OWN name here rather than being merged into a table that means
-- something else. Renaming is safe: nothing has ever successfully written a
-- CW5 base world to a database.
-- ============================================================================

-- The immutable starting state of a world, as the runtime sees it: an object
-- list, not a manifest. Insert-only; the store relies on a PK conflict to
-- enforce immutability, so the primary key is the mechanism, not a decoration.
create table if not exists public.dcsgames_cw5_base_worlds (
  world_id   text        primary key,
  base       jsonb       not null,
  created_at timestamptz not null default now()
);

-- Append-only op log. Idempotent on (world_id, seq): the store treats a PK
-- conflict as "already applied" rather than as an error, which is what makes a
-- retried save safe.
create table if not exists public.dcsgames_world_deltas (
  world_id   text        not null,
  seq        bigint      not null,
  session_id text,
  ts         timestamptz not null default now(),
  actor_id   text,
  ops        jsonb       not null,
  primary key (world_id, seq)
);

-- Reading the whole op log on every load does not scale, so a compacted
-- snapshot is kept per world and the tail is replayed over it.
create index if not exists dcsgames_world_deltas_replay_idx
  on public.dcsgames_world_deltas(world_id, seq asc);

create table if not exists public.dcsgames_world_snapshots (
  world_id   text        primary key,
  as_of_seq  bigint      not null,
  snapshot   jsonb       not null,
  ts         timestamptz not null default now()
);
