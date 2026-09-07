-- 0011 — the safety report table could not store a safety report.
--
-- Every write to dcsgames_reports failed, so no report has ever reached the
-- durable store. They landed in the file shadow instead, which on Railway is
-- the container's own disk — so the moderation queue was emptied by every
-- deploy. Reports of csam, grooming and self_harm were the ones being lost.
--
-- The store said so, to its credit: /health carried
--   safety_persistence.degraded = [{collection:"reports",
--                                   error:"supabase: dcsgames_reports upsert failed (400)"}]
-- but only once a write had already been attempted and lost, and nothing
-- treated a degraded safety collection as more serious than any other.
--
-- Two mismatches between src/core/safety.mjs and 0004, both reproduced directly
-- against the Data API with the service-role key:
--
--   PGRST204  "Could not find the 'escalated' column of 'dcsgames_reports'"
--   23514     dcsgames_reports_status_check — the row carries status
--             'under_review', and 0004 allows only
--             open / triaged / actioned / dismissed / escalated
--
-- This migration changes the TABLE rather than the code, deliberately. The
-- application's vocabulary is the one the safety logic, the escalation alert
-- and the T&S console already speak; redefining 'under_review' as 'escalated'
-- to fit the constraint would be changing what a report MEANS in order to make
-- it fit its column, and `escalated` as a boolean carries something the status
-- cannot — a report can be escalated and then actioned, and must still be
-- findable as one that was escalated.
--
-- Additive only: no existing row changes, and the widened check is a superset
-- of the old one.

alter table public.dcsgames_reports
  add column if not exists escalated boolean not null default false;

-- Widen the status vocabulary. Drop-and-recreate because a check constraint
-- cannot be altered in place.
alter table public.dcsgames_reports
  drop constraint if exists dcsgames_reports_status_check;

alter table public.dcsgames_reports
  add constraint dcsgames_reports_status_check
  check (status in ('open','triaged','under_review','actioned','dismissed','escalated'));

-- Escalated-and-open is the queue a moderator must see first.
create index if not exists dcsgames_reports_escalated_idx
  on public.dcsgames_reports(escalated, status, created_at desc)
  where escalated;

-- PostgREST caches the schema; a new column stays invisible to the Data API
-- until it reloads, which looks exactly like the error this migration fixes.
notify pgrst, 'reload schema';
