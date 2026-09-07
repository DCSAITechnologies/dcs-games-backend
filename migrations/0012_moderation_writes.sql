-- 0012 — reports persist; moderation DECISIONS still did not.
--
-- 0011 fixed the first write in the safety flow and left the other three
-- failing, so filing a report worked and acting on one did not. Found by the
-- adversarial review of that fix, which drove the real service and compared the
-- rows it produced against the SQL rather than reading the code.
--
-- Three separate mismatches between src/core/safety.mjs and 0004:
--
--   1. moderate() writes `action` onto dcsgames_reports. There is no such
--      column, so the update fails with the same PGRST204 that 0011 was written
--      to end.
--   2. it writes `audit` onto dcsgames_moderation_actions — the record of WHO
--      decided WHAT and WHEN, which is the entire point of a moderation audit
--      trail. No such column either.
--   3. MOD_ACTIONS is [warn, ban, shadow_limit, dismiss] and /health publishes
--      that list as the accepted set, while the table's check allows
--      none/warn/hide/unpublish/suspend/ban/age_restrict/escalate_to_authority.
--      So two of the four actions the API tells callers to use fail with 23514.
--
-- The report status vocabulary is widened for the same reason 0011 widened it:
-- applyModeration produces appealed / appeal_upheld / appeal_denied, and a
-- state the code can reach that the column refuses is a write that fails at the
-- worst possible moment. Additive only; the widened checks are supersets.

alter table public.dcsgames_reports
  add column if not exists action text;

alter table public.dcsgames_moderation_actions
  add column if not exists audit jsonb;

-- The vocabulary the application actually speaks, added to the one the table
-- already allowed. Nothing existing is invalidated.
alter table public.dcsgames_moderation_actions
  drop constraint if exists dcsgames_moderation_actions_action_check;

alter table public.dcsgames_moderation_actions
  add constraint dcsgames_moderation_actions_action_check
  check (action in (
    'none','warn','hide','unpublish','suspend','ban','age_restrict','escalate_to_authority',
    'shadow_limit','dismiss'
  ));

alter table public.dcsgames_reports
  drop constraint if exists dcsgames_reports_status_check;

alter table public.dcsgames_reports
  add constraint dcsgames_reports_status_check
  check (status in (
    'open','triaged','under_review','actioned','dismissed','escalated',
    'appealed','appeal_upheld','appeal_denied'
  ));

notify pgrst, 'reload schema';
