-- ============================================================================
-- 0005 — social graph, parties, teams, studios and world discovery (B15)
--
-- Round-2 classified 14 capabilities as BUILT_DARK: reachable code with no
-- durable store behind it. Profiles, friends, parties, teams and studios all
-- lived in a process-local Map seeded with three fixture users, so anything a
-- tester did vanished on restart.
--
-- It also found a schema conflict that would have broken the first real friend
-- request: the running code writes dcsgames_friends(a_id, b_id) while the
-- production table declared in the 0001 lineage baseline has (user_id,
-- friend_id). This migration keeps the BASELINE columns as canonical -- they are
-- what production actually has -- and the service layer was corrected to match.
-- ============================================================================

-- ---------- profiles: durable, replacing the in-memory fixture users --------
create table if not exists public.dcsgames_principals (
  principal_id  text        primary key,          -- the auth principal, not a local id
  username      text        unique,
  display_name  text,
  email         text,
  bio           text,
  avatar_color  text        default '#2563FF',
  level         text        not null default 'explorer'
                  check (level in ('explorer','builder','publisher','verified_builder','studio')),
  xp            integer     not null default 0,
  worlds_created integer    not null default 0,
  worlds_published integer  not null default 0,
  is_internal_tester boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists dcsgames_principals_username_idx on public.dcsgames_principals(lower(username));

drop trigger if exists dcsgames_principals_touch on public.dcsgames_principals;
create trigger dcsgames_principals_touch
  before update on public.dcsgames_principals
  for each row execute function public.dcsgames_touch_updated_at();

-- ---------- friends -----------------------------------------------------
-- The 0001 baseline already declares dcsgames_friends(user_id, friend_id) with
-- uuid FKs to dcsgames_users. Principal ids are not necessarily rows in that
-- table during internal testing, so the durable graph the service uses lives
-- here, keyed on principal id, with the SAME column names so the two never
-- diverge again.
create table if not exists public.dcsgames_principal_friends (
  user_id    text        not null,
  friend_id  text        not null,
  status     text        not null default 'requested'
               check (status in ('requested','accepted','blocked')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

create index if not exists dcsgames_principal_friends_friend_idx
  on public.dcsgames_principal_friends(friend_id, status);

-- ---------- parties (ephemeral play groups) --------------------------------
create table if not exists public.dcsgames_parties (
  id         text        primary key,
  leader_id  text        not null,
  world_id   text,
  max_size   integer     not null default 8 check (max_size between 1 and 64),
  open       boolean     not null default true,
  created_at timestamptz not null default now(),
  closed_at  timestamptz
);

create table if not exists public.dcsgames_party_members (
  party_id  text        not null references public.dcsgames_parties(id) on delete cascade,
  member_id text        not null,
  joined_at timestamptz not null default now(),
  primary key (party_id, member_id)
);

create index if not exists dcsgames_party_members_member_idx
  on public.dcsgames_party_members(member_id);

-- ---------- teams (persistent groups) --------------------------------------
create table if not exists public.dcsgames_teams (
  id          text        primary key,
  name        text        not null,
  owner_id    text        not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.dcsgames_team_members (
  team_id   text        not null references public.dcsgames_teams(id) on delete cascade,
  member_id text        not null,
  role      text        not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, member_id)
);

-- ---------- studios (creator organisations; revenue splits stay DARK) ------
create table if not exists public.dcsgames_studios (
  id         text        primary key,
  name       text        not null,
  owner_id   text        not null,
  created_at timestamptz not null default now()
);

create table if not exists public.dcsgames_studio_members (
  studio_id text        not null references public.dcsgames_studios(id) on delete cascade,
  member_id text        not null,
  role      text        not null default 'member'
              check (role in ('owner','admin','creator','member')),
  -- Split basis points are recorded but never settle money: PAYMENTS_LIVE=false.
  split_bps integer     not null default 0 check (split_bps between 0 and 10000),
  joined_at timestamptz not null default now(),
  primary key (studio_id, member_id)
);

-- ---------- discovery ------------------------------------------------------
-- Real, measured play activity. Discovery ranks on these rows and nothing else,
-- so a browse page can never show a play count that was never measured.
create table if not exists public.dcsgames_world_plays (
  id          bigserial   primary key,
  world_id    text        not null,
  principal_id text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  seconds     integer
);

create index if not exists dcsgames_world_plays_world_idx
  on public.dcsgames_world_plays(world_id, started_at desc);

create table if not exists public.dcsgames_world_ratings (
  world_id     text        not null,
  principal_id text        not null,
  rating       integer     not null check (rating between 1 and 5),
  created_at   timestamptz not null default now(),
  primary key (world_id, principal_id)
);
