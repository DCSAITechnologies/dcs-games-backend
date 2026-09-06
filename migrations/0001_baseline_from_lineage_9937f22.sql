-- ============================================================
-- DCS Games — Platform Data Model (Supabase / Postgres)
-- Namespace: dcsgames_*  ·  Money in MINOR units (cents/coins, integer-safe)
-- All real-money + payout flows ship DARK (live=false) until DK flips.
-- Idempotent: safe to run once on the dedicated UGC Supabase project.
-- This is the PLATFORM/web backend (dashboards, social, marketplace, rewards,
-- trust). The game RUNTIME (engine/netcode/AI gen) is the engine-track, separate.
-- ============================================================

-- ---------- Identity & profile ----------
create table if not exists public.dcsgames_users (
  id            uuid primary key default gen_random_uuid(),
  username      text unique not null,
  display_name  text,
  email         text,                          -- auth handled by Supabase Auth; mirror id
  avatar_color  text default '#2563FF',
  level         integer not null default 1,
  xp            integer not null default 0,
  coins         integer not null default 0,     -- soft currency (minor units)
  rank_tier     text not null default 'bronze'  -- bronze|silver|gold|diamond|legend|mythic
                  check (rank_tier in ('bronze','silver','gold','diamond','legend','mythic')),
  is_creator    boolean not null default false,
  age_tier      text,                           -- 13+|16+|18+ (set by CW7 safety/verification)
  verified_by_atlas text default 'none' check (verified_by_atlas in ('none','pending','verified')),
  daily_streak  integer not null default 0,
  created_at    timestamptz not null default now()
);

create table if not exists public.dcsgames_profiles (
  user_id        uuid primary key references public.dcsgames_users(id) on delete cascade,
  bio            text,
  banner_color   text default '#7C3AED',
  followers      integer not null default 0,
  following       integer not null default 0,
  hours_played   integer not null default 0,
  worlds_played  integer not null default 0,
  worlds_created integer not null default 0,
  updated_at     timestamptz not null default now()
);

-- ---------- Worlds (the core content) ----------
create table if not exists public.dcsgames_worlds (
  id             uuid primary key default gen_random_uuid(),
  slug           text unique not null,
  title          text not null,
  creator_id     uuid references public.dcsgames_users(id) on delete set null,
  genre          text not null,                 -- horror|survival|adventure|scifi|fantasy|...
  maturity       text not null default '13+' check (maturity in ('13+','16+','18+')),
  difficulty     text default 'medium',
  thumbnail_url  text,
  trailer_url    text,
  status         text not null default 'draft'  check (status in ('draft','published','archived')),
  atlas_verified boolean not null default false,
  safety_rating  integer,                       -- 0-100 (Atlas/CW7)
  total_plays    bigint not null default 0,
  rating_avg     numeric(3,2) default 0,
  ratings_count  integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists dcsgames_worlds_genre_idx on public.dcsgames_worlds(genre);
create index if not exists dcsgames_worlds_status_idx on public.dcsgames_worlds(status);

create table if not exists public.dcsgames_world_live (
  world_id       uuid primary key references public.dcsgames_worlds(id) on delete cascade,
  live_players   integer not null default 0,
  updated_at     timestamptz not null default now()
);

create table if not exists public.dcsgames_play_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.dcsgames_users(id) on delete cascade,
  world_id    uuid not null references public.dcsgames_worlds(id) on delete cascade,
  progress_pct integer default 0,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
create index if not exists dcsgames_play_user_idx on public.dcsgames_play_sessions(user_id, started_at desc);

-- ---------- Social: friends, crews ----------
create table if not exists public.dcsgames_friends (
  user_id    uuid not null references public.dcsgames_users(id) on delete cascade,
  friend_id  uuid not null references public.dcsgames_users(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id)
);

create table if not exists public.dcsgames_crews (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  banner_color  text default '#7C3AED',
  emblem        text,
  leader_id     uuid references public.dcsgames_users(id) on delete set null,
  level         integer not null default 1,
  xp            integer not null default 0,
  rank_tier     text default 'gold',
  members_count integer not null default 1,
  created_at    timestamptz not null default now()
);
create table if not exists public.dcsgames_crew_members (
  crew_id   uuid not null references public.dcsgames_crews(id) on delete cascade,
  user_id   uuid not null references public.dcsgames_users(id) on delete cascade,
  role      text not null default 'member' check (role in ('member','officer','leader')),
  joined_at timestamptz not null default now(),
  primary key (crew_id, user_id)
);

-- ---------- Events ----------
create table if not exists public.dcsgames_events (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  kind         text not null default 'live' check (kind in ('live','seasonal','crew','tournament','community','daily','weekend')),
  banner_url   text,
  prize_pool   integer default 0,               -- minor units, DARK
  participants integer not null default 0,
  starts_at    timestamptz,
  ends_at      timestamptz,
  created_at   timestamptz not null default now()
);
create table if not exists public.dcsgames_event_participants (
  event_id uuid not null references public.dcsgames_events(id) on delete cascade,
  user_id  uuid not null references public.dcsgames_users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

-- ---------- Leaderboards (scoped) ----------
create table if not exists public.dcsgames_leaderboard (
  id        uuid primary key default gen_random_uuid(),
  scope     text not null check (scope in ('global','friends','crew','world','season')),
  scope_ref uuid,                               -- world_id/crew_id/null for global/season
  user_id   uuid not null references public.dcsgames_users(id) on delete cascade,
  score     integer not null default 0,
  season    text,
  updated_at timestamptz not null default now()
);
create index if not exists dcsgames_lb_scope_idx on public.dcsgames_leaderboard(scope, scope_ref, score desc);

-- ---------- Marketplace (DARK money) ----------
create table if not exists public.dcsgames_market_items (
  id            uuid primary key default gen_random_uuid(),
  type          text not null check (type in ('world','asset','npc','script','ai_agent','music','animation','effect','voice_pack','game_pass','subscription','economy_template','reward')),
  title         text not null,
  creator_id    uuid references public.dcsgames_users(id) on delete set null,
  price_cents   integer not null default 0,     -- minor units
  preview_url   text,
  rating_avg    numeric(3,2) default 0,
  sales_count   integer not null default 0,
  atlas_verified boolean not null default false,
  live          boolean not null default false, -- DARK until DK flips
  created_at    timestamptz not null default now()
);
create table if not exists public.dcsgames_purchases (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.dcsgames_users(id) on delete cascade,
  item_id     uuid not null references public.dcsgames_market_items(id) on delete cascade,
  price_cents integer not null,
  live        boolean not null default false,   -- DARK / shadow record
  created_at  timestamptz not null default now()
);

-- ---------- Rewards / progression ----------
create table if not exists public.dcsgames_battle_pass (
  user_id  uuid not null references public.dcsgames_users(id) on delete cascade,
  season   text not null,
  level    integer not null default 1,
  xp       integer not null default 0,
  premium  boolean not null default false,
  primary key (user_id, season)
);
create table if not exists public.dcsgames_daily_rewards (
  user_id    uuid not null references public.dcsgames_users(id) on delete cascade,
  reward_date date not null,
  day_index  integer,
  claimed_at timestamptz not null default now(),
  primary key (user_id, reward_date)
);
create table if not exists public.dcsgames_achievements (
  id      uuid primary key default gen_random_uuid(),
  name    text not null,
  descr   text,
  rarity  text default 'common'
);
create table if not exists public.dcsgames_user_achievements (
  user_id uuid not null references public.dcsgames_users(id) on delete cascade,
  achievement_id uuid not null references public.dcsgames_achievements(id) on delete cascade,
  progress_pct integer default 0,
  unlocked_at  timestamptz,
  primary key (user_id, achievement_id)
);

-- ---------- Inventory: items, pets, vehicles, artifacts ----------
create table if not exists public.dcsgames_inventory (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references public.dcsgames_users(id) on delete cascade,
  kind      text not null check (kind in ('item','pet','vehicle','artifact','skin','title','mount')),
  ref_id    text,
  name      text,
  rarity    text default 'common',  -- common|rare|epic|legendary|mythic (drives glow)
  power     integer,
  acquired_at timestamptz not null default now()
);
create index if not exists dcsgames_inv_user_idx on public.dcsgames_inventory(user_id, kind);

-- ---------- Notifications ----------
create table if not exists public.dcsgames_notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.dcsgames_users(id) on delete cascade,
  kind       text not null,        -- system|friend|crew|event|reward|marketplace|world
  title      text not null,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists dcsgames_notif_user_idx on public.dcsgames_notifications(user_id, created_at desc);

-- ---------- Creator analytics (daily rollups) ----------
create table if not exists public.dcsgames_world_analytics (
  world_id      uuid not null references public.dcsgames_worlds(id) on delete cascade,
  day           date not null,
  dau           integer default 0,
  wau           integer default 0,
  mau           integer default 0,
  session_secs  bigint default 0,
  retention_d7  numeric(5,2) default 0,
  revenue_cents integer default 0,  -- DARK
  primary key (world_id, day)
);

-- ---------- Atlas trust (game-side; mirrors Atlas receipt envelope) ----------
create table if not exists public.dcsgames_atlas_receipts (
  id           uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('creator','world','event','reward','asset')),
  subject_id   uuid not null,
  attestation  jsonb not null,        -- CW7-defined fields (safety_rating, age_tier, …)
  attested_by  text,
  trust_status text not null default 'pre-gate-1',
  sig          text,
  prev_hash    text,
  created_at   timestamptz not null default now()
);
create index if not exists dcsgames_receipts_subject_idx on public.dcsgames_atlas_receipts(subject_type, subject_id, created_at desc);
