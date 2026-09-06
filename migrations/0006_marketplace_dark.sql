-- ============================================================================
-- 0006 — marketplace backend, prepared while money stays DARK (B15)
--
-- Round-2 called the marketplace "doubly dark": the economy router was
-- constructed with no database client, so its live branch was unreachable, AND
-- its three tables (dcsgames_listings, dcsgames_storefronts, dcsgames_ownership)
-- returned PGRST205 because they did not exist.
--
-- This creates them, so the marketplace can be built and tested properly. The
-- money stays off, and it stays off at the DATABASE level rather than only in
-- application code: a CHECK constraint makes a non-zero price impossible on a
-- test-mode listing, and a settled ledger entry impossible while test_mode is
-- true. Flipping PAYMENTS_LIVE in the environment is therefore not sufficient to
-- move money; the rows themselves refuse it.
-- ============================================================================

create table if not exists public.dcsgames_storefronts (
  id          text        primary key,
  owner_id    text        not null,
  name        text        not null,
  description text,
  studio_id   text,
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists dcsgames_storefronts_owner_idx
  on public.dcsgames_storefronts(owner_id);

create table if not exists public.dcsgames_listings (
  id            text        primary key,
  storefront_id text        references public.dcsgames_storefronts(id) on delete cascade,
  seller_id     text        not null,
  world_id      text,
  kind          text        not null default 'world'
                  check (kind in ('world','asset','npc','script','music','animation','effect','voice_pack')),
  title         text        not null,
  description   text,
  price_minor   integer     not null default 0 check (price_minor >= 0),
  currency      text        not null default 'INR',
  test_mode     boolean     not null default true,
  active        boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- The money guard. A test-mode listing CANNOT carry a price, whatever the
  -- application layer believes. Turning the marketplace on is therefore a
  -- deliberate schema-and-flag change, not an environment variable away.
  constraint dcsgames_listings_dark_price check (test_mode = false or price_minor = 0)
);

create index if not exists dcsgames_listings_active_idx
  on public.dcsgames_listings(active, created_at desc);
create index if not exists dcsgames_listings_seller_idx
  on public.dcsgames_listings(seller_id);

drop trigger if exists dcsgames_listings_touch on public.dcsgames_listings;
create trigger dcsgames_listings_touch
  before update on public.dcsgames_listings
  for each row execute function public.dcsgames_touch_updated_at();

-- What a principal holds. During internal testing everything here is acquired
-- at zero cost, which is why acquired_price_minor has the same guard.
create table if not exists public.dcsgames_ownership (
  id            text        primary key,
  owner_id      text        not null,
  listing_id    text        references public.dcsgames_listings(id) on delete set null,
  world_id      text,
  name          text,
  acquired_at   timestamptz not null default now(),
  acquired_price_minor integer not null default 0 check (acquired_price_minor >= 0),
  test_mode     boolean     not null default true,

  constraint dcsgames_ownership_dark_price check (test_mode = false or acquired_price_minor = 0)
);

create index if not exists dcsgames_ownership_owner_idx
  on public.dcsgames_ownership(owner_id, acquired_at desc);
create unique index if not exists dcsgames_ownership_once_idx
  on public.dcsgames_ownership(owner_id, listing_id)
  where listing_id is not null;

-- The ledger. Every entry is recorded; none may be settled while test_mode is
-- true, so the 70/30 split can be modelled without a single rupee moving.
create table if not exists public.dcsgames_ledger (
  ref           text        primary key,
  buyer_id      text        not null,
  seller_id     text,
  listing_id    text,
  gross_minor   integer     not null default 0 check (gross_minor >= 0),
  seller_minor  integer     not null default 0 check (seller_minor >= 0),
  platform_minor integer    not null default 0 check (platform_minor >= 0),
  currency      text        not null default 'INR',
  status        text        not null default 'test'
                  check (status in ('test','hold','settled','refunded','void')),
  test_mode     boolean     not null default true,
  created_at    timestamptz not null default now(),

  constraint dcsgames_ledger_dark_amount check (test_mode = false or (gross_minor = 0 and seller_minor = 0 and platform_minor = 0)),
  constraint dcsgames_ledger_dark_status check (test_mode = false or status = 'test'),
  -- The split must always add up, even at zero.
  constraint dcsgames_ledger_split_balances check (seller_minor + platform_minor = gross_minor)
);

create index if not exists dcsgames_ledger_buyer_idx
  on public.dcsgames_ledger(buyer_id, created_at desc);
create index if not exists dcsgames_ledger_seller_idx
  on public.dcsgames_ledger(seller_id, created_at desc);

comment on constraint dcsgames_ledger_dark_amount on public.dcsgames_ledger is
  'Money stays dark at the database level. Setting PAYMENTS_LIVE in the environment is not enough to move money; a deliberate schema change is required.';
