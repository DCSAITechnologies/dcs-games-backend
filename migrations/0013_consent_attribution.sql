-- 0013 — a third table could not store what the code writes to it.
--
-- The same PGRST204 as 0011 and 0012, found by generalising the adversarial
-- test to drive EVERY safety write rather than the one that had already
-- failed. 0011 fixed reports because that is where the symptom appeared; 0012
-- fixed moderation because that is where I looked next; neither visited this
-- one.
--
-- dcsgames_parental_consent has no `requested_by` and no `decided_by`, and
-- safety.mjs writes both:
--
--   requestParentalConsent()  ... requested_by: String(requestedBy)
--   decideParentalConsent()   ... decided_by: decidedBy
--
-- These are the records saying a guardian was ASKED about a minor and what
-- they ANSWERED, and the attribution is the part that makes them mean
-- anything. A consent record that cannot say who requested it is exactly what
-- safety.mjs already refuses to write in memory — it throws rather than record
-- one anonymously — and the column it would be written to did not exist, so
-- the remote write failed even when the attribution was present.
--
-- The status vocabulary is widened for the same reason as the other two: the
-- service also produces 'withdrawn', and a state the code can reach that the
-- column refuses is a write that fails at the worst possible moment.
--
-- Additive only. No existing row changes; the widened check is a superset.

alter table public.dcsgames_parental_consent
  add column if not exists requested_by text;

alter table public.dcsgames_parental_consent
  add column if not exists decided_by text;

alter table public.dcsgames_parental_consent
  drop constraint if exists dcsgames_parental_consent_status_check;

alter table public.dcsgames_parental_consent
  add constraint dcsgames_parental_consent_status_check
  check (status in ('pending','granted','denied','revoked','withdrawn','expired'));

notify pgrst, 'reload schema';
