-- ============================================================================
-- 0008 — subscriptions, built dark (B15)
--
-- The build this replaces carried a subscriptions table whose status vocabulary
-- was 'active' | 'past_due' and a bare dcsgames_users.dcs_plus boolean, with no
-- guard of any kind. That schema is still sitting in identity-schema.sql, which
-- is NOT in this chain; applying it would re-permit exactly what the service
-- layer exists to prevent, and it is the schema the invented "active" fixture
-- row came from.
--
-- Money is dark in three places on this estate: the service refuses, the
-- PAYMENTS_LIVE flag is false, and the database says no. This is the third.
-- A status meaning "this person is paying" has nowhere to be written here, so
-- it cannot be written by accident, by an import, by a manual edit, or by a
-- future migration that forgets why.
--
-- Turning subscriptions on is therefore a deliberate schema change plus a real
-- PSP integration plus a founder decision — not an environment variable.
-- ============================================================================

create table if not exists public.dcsgames_subscriptions (
  principal_id text        primary key,
  plan         text        not null default 'free'
                 check (plan in ('free','dcs_plus')),
  -- No 'active'. No 'trialing'. No 'past_due'.
  status       text        not null default 'comped'
                 check (status in ('comped','revoked')),
  test_mode    boolean     not null default true,
  comped       boolean     not null default true,
  price_minor  integer     not null default 0 check (price_minor = 0),
  currency     text        not null default 'INR',
  granted_by   text        not null,
  reason       text,
  granted_at   timestamptz not null default now(),
  -- NOT NULL deliberately, and stricter than the service currently is: the
  -- service defaults this to the window end but still writes null if a caller
  -- passes expiresAt:null explicitly, which would produce a comped grant that
  -- never expires. A grant made for a test window must die with the window even
  -- if the code that created it forgot to say so.
  expires_at   timestamptz not null,
  revoked_at   timestamptz,

  -- The money guard. A subscription that is not comped cannot exist, whatever
  -- the application layer believes, and a comped one cannot carry a price.
  constraint dcsgames_subscriptions_dark
    check (test_mode = true and comped = true and price_minor = 0),

  -- The controlled internal testing window closes 30 September 2026. Nothing
  -- granted under it may outlive it.
  constraint dcsgames_subscriptions_internal_window
    check (expires_at <= timestamptz '2026-10-01T00:00:00Z')
);

create index if not exists dcsgames_subscriptions_plan_idx
  on public.dcsgames_subscriptions(plan, status);

-- Every grant and revocation is auditable, including a refused subscribe: an
-- attempt to pay is evidence of demand and must not vanish just because it was
-- correctly refused. An empty table is an honest "nobody has been comped".
create table if not exists public.dcsgames_subscription_events (
  id           text        primary key,
  principal_id text        not null,
  event        text        not null
                 check (event in ('granted','revoked','subscribe_refused')),
  plan         text,
  actor_id     text        not null,
  reason       text,
  created_at   timestamptz not null default now()
);

create index if not exists dcsgames_subscription_events_principal_idx
  on public.dcsgames_subscription_events(principal_id, created_at desc);
