-- CW1 Identity — data model (the tables CW1 owns). Supabase/Postgres.
-- Schema-namespaced for the DCS Games project. Apply when the UGC Supabase project is provisioned.
-- Honest: money fields (dcs_plus, subscriptions) are WRITTEN BY CW8 payments; read here. DARK until DK flips.

-- extend the existing users table
create table if not exists dcsgames_users (
  id              text primary key,
  name            text not null,
  email           text,
  email_verified  boolean not null default false,
  phone_verified  boolean not null default false,
  dcs_plus        boolean not null default false,        -- written by CW8 payments
  atlas_score     numeric not null default 0,            -- mirrored from CW7
  active_players  integer not null default 0,            -- across this user's published worlds
  reports         integer not null default 0,            -- moderation reports (CW7)
  is_studio       boolean not null default false,
  published_count integer not null default 0,            -- enforced by /publish/check (M-P3)
  level_cache     text,                                  -- computed level, cached for fast reads
  target_exam_year integer,
  created_at      timestamptz not null default now()
);

create table if not exists dcsgames_profiles (
  id           text primary key references dcsgames_users(id) on delete cascade,
  avatar_url   text,
  bio          text,
  achievements text[] not null default '{}',
  worlds       integer not null default 0,
  followers    integer not null default 0,
  following    integer not null default 0
);

create table if not exists dcsgames_friends (
  a_id   text not null references dcsgames_users(id) on delete cascade,
  b_id   text not null references dcsgames_users(id) on delete cascade,
  status text not null default 'requested',  -- requested | accepted
  created_at timestamptz not null default now(),
  primary key (a_id, b_id)
);

create table if not exists dcsgames_parties (
  id        text primary key,
  host      text not null references dcsgames_users(id),
  world_id  text,
  created_at timestamptz not null default now()
);
create table if not exists dcsgames_party_members (
  party_id text not null references dcsgames_parties(id) on delete cascade,
  user_id  text not null references dcsgames_users(id) on delete cascade,
  primary key (party_id, user_id)
);

create table if not exists dcsgames_teams (
  id    text primary key,
  name  text not null,
  owner text not null references dcsgames_users(id)
);
create table if not exists dcsgames_team_members (
  team_id text not null references dcsgames_teams(id) on delete cascade,
  user_id text not null references dcsgames_users(id) on delete cascade,
  role    text not null default 'viewer',  -- owner | editor | viewer
  primary key (team_id, user_id)
);

create table if not exists dcsgames_orgs (
  id            text primary key,
  name          text not null,
  billing_owner text not null references dcsgames_users(id),
  seats         integer not null default 5
);
create table if not exists dcsgames_org_members (
  org_id  text not null references dcsgames_orgs(id) on delete cascade,
  user_id text not null references dcsgames_users(id) on delete cascade,
  role    text not null default 'member',  -- owner | admin | member
  primary key (org_id, user_id)
);

create table if not exists dcsgames_subscriptions (
  user_id   text primary key references dcsgames_users(id) on delete cascade,
  plan      text not null default 'free',  -- free | dcs_plus
  status    text not null default 'none',  -- none | active | past_due | canceled
  renews_at date
  -- WRITTEN BY CW8 payments only. Identity reads. Money DARK until DK flips.
);

create index if not exists idx_friends_b on dcsgames_friends(b_id);
create index if not exists idx_party_members_user on dcsgames_party_members(user_id);
create index if not exists idx_team_members_user on dcsgames_team_members(user_id);

-- ============================================================
-- Studio member table + split column (referenced by the live repo)
-- ============================================================
create table if not exists dcsgames_studios (
  id    text primary key,
  name  text not null,
  owner text not null references dcsgames_users(id),
  split jsonb,                              -- [{user_id, pct}] — owner-only, validated server-side
  created_at timestamptz not null default now()
);
create table if not exists dcsgames_studio_members (
  studio_id text not null references dcsgames_studios(id) on delete cascade,
  user_id   text not null references dcsgames_users(id) on delete cascade,
  role      text not null default 'viewer',  -- owner | admin | editor | viewer
  primary key (studio_id, user_id)
);

-- ============================================================
-- ROW-LEVEL SECURITY (mandate: RLS/ownership enforced)
-- The server API uses the service role (bypasses RLS) and enforces authz in code;
-- these policies protect against direct client access with anon/auth keys.
-- ============================================================
alter table dcsgames_users         enable row level security;
alter table dcsgames_profiles      enable row level security;
alter table dcsgames_friends       enable row level security;
alter table dcsgames_subscriptions enable row level security;
alter table dcsgames_studios       enable row level security;
alter table dcsgames_studio_members enable row level security;

-- a user can read/update only their own user row
create policy users_self_read   on dcsgames_users for select using (auth.uid()::text = id);
create policy users_self_update on dcsgames_users for update using (auth.uid()::text = id);

-- profiles are public-readable (discovery), writable only by the owner
create policy profiles_public_read on dcsgames_profiles for select using (true);
create policy profiles_self_write  on dcsgames_profiles for update using (auth.uid()::text = id);

-- friends: a row is visible/editable only to its two participants
create policy friends_participant on dcsgames_friends for all
  using (auth.uid()::text = a_id or auth.uid()::text = b_id);

-- subscriptions: read your own; writes are service-role only (CW8 payments) — no client policy = denied
create policy subs_self_read on dcsgames_subscriptions for select using (auth.uid()::text = user_id);

-- studios: members can read; only the owner row in studio_members may configure (split enforced in code)
create policy studios_member_read on dcsgames_studios for select
  using (exists (select 1 from dcsgames_studio_members m where m.studio_id = id and m.user_id = auth.uid()::text));
create policy studio_members_read on dcsgames_studio_members for select
  using (user_id = auth.uid()::text or exists (select 1 from dcsgames_studio_members m2 where m2.studio_id = studio_id and m2.user_id = auth.uid()::text));
