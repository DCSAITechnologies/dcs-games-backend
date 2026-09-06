# Staging deployment ledger

Which commit each running deployment carries. `/health` reports
`build.deployment_id`; look it up here to get the commit.

Written by `scripts/deploy-staging.sh`, which refuses to add a row unless the
live service actually reports the deployment id it just created.

| when (UTC) | deployment id | commit | branch |
| --- | --- | --- | --- |
| 2026-09-06T22:20:52Z | `95461ad5-e670-4321-aa47-a3a6be33dc02` | `06af35843c55b2aacd465ac82da7664f3a743df0` | sprint/2026-09-canonical |
