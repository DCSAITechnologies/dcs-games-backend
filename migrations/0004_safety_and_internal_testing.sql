-- ============================================================================
-- 0004 — child-safety, consent and controlled-internal-testing architecture (A5)
--
-- Engineering-complete, PUBLIC-LAUNCH-BLOCKED. These tables exist so age gating,
-- reporting, blocking and parental consent are real code paths during internal
-- testing. Onboarding real minors stays disabled until safety/legal clearance;
-- see 00_PUBLIC_LAUNCH_BLOCKERS_AND_APPROVALS.md.
-- ============================================================================

-- Who may use the product during the controlled window (through 30 Sep 2026).
create table if not exists public.dcsgames_internal_testers (
  principal_id text        primary key,
  email        text,
  role         text        not null default 'tester'
                 check (role in ('founder','staff','tester','admin')),
  approved_by  text,
  approved_at  timestamptz not null default now(),
  revoked_at   timestamptz
);

create index if not exists dcsgames_internal_testers_email_idx
  on public.dcsgames_internal_testers(lower(email));

-- Age assurance. date_of_birth is deliberately NOT stored alongside the derived
-- tier: services read the tier, and only the safety lane reads the raw DOB.
create table if not exists public.dcsgames_age_assurance (
  principal_id  text        primary key,
  date_of_birth date,
  age_tier      text        not null default 'unknown'
                  check (age_tier in ('unknown','under13','13_15','16_17','adult')),
  method        text        not null default 'self_declared'
                  check (method in ('self_declared','parental_attested','document_verified','synthetic_test')),
  verified_at   timestamptz,
  updated_at    timestamptz not null default now()
);

-- Parental / guardian consent. Engineering-complete; no real minor is onboarded
-- during the internal window, so rows here are synthetic test data only.
create table if not exists public.dcsgames_parental_consent (
  id            uuid        primary key default gen_random_uuid(),
  minor_id      text        not null,
  guardian_email text       not null,
  scope         text[]      not null default '{}',   -- e.g. {play,create,chat,voice}
  status        text        not null default 'pending'
                  check (status in ('pending','granted','denied','revoked','expired')),
  evidence      jsonb,
  requested_at  timestamptz not null default now(),
  decided_at    timestamptz,
  expires_at    timestamptz,
  is_synthetic  boolean     not null default true    -- internal testing marker
);

create unique index if not exists dcsgames_parental_consent_active_uq
  on public.dcsgames_parental_consent(minor_id, guardian_email)
  where status in ('pending','granted');

-- Report / block. Real persistence, so moderation output can never be faked.
create table if not exists public.dcsgames_reports (
  id            uuid        primary key default gen_random_uuid(),
  reporter_id   text        not null,
  subject_type  text        not null
                  check (subject_type in ('user','world','asset','message','npc','comment')),
  subject_id    text        not null,
  reason        text        not null
                  check (reason in ('csam','grooming','harassment','hate','violence','sexual','self_harm','spam','ip_infringement','other')),
  detail        text,
  status        text        not null default 'open'
                  check (status in ('open','triaged','actioned','dismissed','escalated')),
  severity      text        not null default 'normal'
                  check (severity in ('low','normal','high','critical')),
  handled_by    text,
  handled_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists dcsgames_reports_open_idx
  on public.dcsgames_reports(status, severity, created_at desc);
create index if not exists dcsgames_reports_subject_idx
  on public.dcsgames_reports(subject_type, subject_id);

create table if not exists public.dcsgames_blocks (
  blocker_id text        not null,
  blocked_id text        not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

-- Every moderation decision is auditable. An empty table is an honest
-- "nothing has been moderated", which is what the UI must show.
create table if not exists public.dcsgames_moderation_actions (
  id           uuid        primary key default gen_random_uuid(),
  subject_type text        not null,
  subject_id   text        not null,
  action       text        not null
                 check (action in ('none','warn','hide','unpublish','suspend','ban','age_restrict','escalate_to_authority')),
  rationale    text        not null,
  decided_by   text        not null,          -- principal id or 'automated:<rule>'
  report_id    uuid,
  created_at   timestamptz not null default now()
);

create index if not exists dcsgames_moderation_subject_idx
  on public.dcsgames_moderation_actions(subject_type, subject_id, created_at desc);

-- Consent for voice / likeness / avatar material (B11 launch blocker).
create table if not exists public.dcsgames_media_consent (
  id            uuid        primary key default gen_random_uuid(),
  principal_id  text        not null,
  media_kind    text        not null
                  check (media_kind in ('voice','likeness','avatar','name','performance')),
  source        text        not null
                  check (source in ('founder','staff','synthetic','licensed','explicit_consent')),
  evidence_ref  text,
  granted_at    timestamptz not null default now(),
  revoked_at    timestamptz
);

create index if not exists dcsgames_media_consent_principal_idx
  on public.dcsgames_media_consent(principal_id, media_kind);
