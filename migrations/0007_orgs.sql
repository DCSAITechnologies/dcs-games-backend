-- ============================================================================
-- 0007 — organisation accounts and seats (B15, Round-2 capability 87)
--
-- The routes existed with real seat-check logic, an in-memory store, and no
-- tables at all. They also had no permission check on adding a member: anyone
-- could add themselves to any org and then read it. The service layer fixes the
-- authorisation; this gives the data somewhere durable to live.
--
-- Seats are a CAPACITY limit, not a billing charge. No seat is billed while
-- PAYMENTS_LIVE is false, which is why there is no price column here at all.
-- ============================================================================

create table if not exists public.dcsgames_orgs (
  id            text        primary key,
  name          text        not null,
  billing_owner text        not null,
  seats         integer     not null default 5 check (seats between 1 and 1000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists dcsgames_orgs_owner_idx
  on public.dcsgames_orgs(billing_owner);

drop trigger if exists dcsgames_orgs_touch on public.dcsgames_orgs;
create trigger dcsgames_orgs_touch
  before update on public.dcsgames_orgs
  for each row execute function public.dcsgames_touch_updated_at();

create table if not exists public.dcsgames_org_members (
  org_id    text        not null references public.dcsgames_orgs(id) on delete cascade,
  member_id text        not null,
  role      text        not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key (org_id, member_id)
);

create index if not exists dcsgames_org_members_member_idx
  on public.dcsgames_org_members(member_id);

-- Exactly one owner per org, enforced by the database rather than by convention.
create unique index if not exists dcsgames_org_single_owner_idx
  on public.dcsgames_org_members(org_id)
  where role = 'owner';
