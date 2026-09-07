# Staging deployment ledger

Which commit each running deployment carries. `/health` reports
`build.deployment_id`; look it up here to get the commit.

Written by `scripts/deploy-staging.sh`, which refuses to add a row unless the
live service actually reports the deployment id it just created.

| when (UTC) | deployment id | commit | branch |
| --- | --- | --- | --- |
| 2026-09-06T22:20:52Z | `95461ad5-e670-4321-aa47-a3a6be33dc02` | `06af35843c55b2aacd465ac82da7664f3a743df0` | sprint/2026-09-canonical |
| 2026-09-06T22:30:23Z | `1ba3e812-0a1d-4b09-a6d5-d1f7c83fb54f` | `ff35b701bffdb6f2232f8ec5910263c5cad3da62` | sprint/2026-09-canonical |
| 2026-09-06T22:32:39Z | `521a17c1-73ef-420a-8c7f-6d7d1829a5e9` | `0c2096f70421ba86593ddc1fd454d0d65cb8e7f3` | sprint/2026-09-canonical |
| 2026-09-06T22:41:06Z | `2e2e8df3-ab44-4fe4-a072-c3747ccef7c1` | `163ff8139a786a1f72f59afa34c167ca85eb8e42` | sprint/2026-09-canonical |
| 2026-09-06T22:43:48Z | `1e07eecd-3b61-4662-b1f1-acfba195e518` | `1636baf170a1e7fc1973573740d2166357dbb35d` | sprint/2026-09-canonical |
| 2026-09-06T22:54:52Z | `0acaf9d2-63a6-4401-a383-65540b083fe9` | `b27e257abd53bf8eac2c592fc84ff7e93dcc34ee` | sprint/2026-09-canonical |
| 2026-09-06T23:20:14Z | `d3514782-356d-4554-a6a2-f2f9aedd6c32` | `dd49eff09aaa2f46bb49486baf7e6f2c003eca1a` | sprint/2026-09-canonical |
| 2026-09-07T00:12:43Z | `d8ca0e6e-7eb0-4a15-ad85-cf38ceab7ac4` | `e1ce92ce03b78a5b03b97347621fe11ca8f527d8` | sprint/2026-09-canonical |
| 2026-09-07T00:14:24Z | `ceae8d4c-b467-4fb8-b474-0faa3bc6f856` | `c9e117429632361246711d6b1f401533d5ef7b25` | sprint/2026-09-canonical |
| 2026-09-07T00:20:09Z | `bc0d4c28-4280-4570-8171-35c975f42223` | `abbba0ce14d677f94ffba7ecb83fe7d6f911bf91` | sprint/2026-09-canonical |
| 2026-09-07T00:43:28Z | `6e4b0b4e-9521-43c3-b3f0-a568063ebff1` | `746803144681018f5ff0b9b2e7cce2ee417b96af` | sprint/2026-09-canonical |
| 2026-09-07T00:50:39Z | `292da002-41bf-4f2d-952f-326fed5f1b1f` | `d5c88a9e8dda3fd11c1bb750c39337e4b1d4750b` | sprint/2026-09-canonical |
| 2026-09-07T00:52:56Z | `3d4e7d69-0944-4964-9e6b-7abee941fbf4` | `b8225efb5eba7da57439d0de9973a934b32e398b` | sprint/2026-09-canonical |
| 2026-09-07T00:55:03Z | `2fdf2945-9567-47fc-9755-f06e4fb6831c` | `54ccd17223817ce4d912e235a328229137a34dab` | sprint/2026-09-canonical |
| 2026-09-07T01:18:53Z | `330d80ab-cad2-41f2-8cac-45825a52ca1f` | `0b477c5f2c80d597991ccfe2d56ceddab236f491` | sprint/2026-09-canonical |
| 2026-09-07T01:37:47Z | `75ac7a98-5ffd-4ff0-966b-b2e68ebd5c94` | `2ec3a6330c42476334691c5104550c94bf59deda` | sprint/2026-09-canonical |
| 2026-09-07T02:11:52Z | `0316e3e6-7b0c-4ea4-91ff-f60ef73a5bf6` | `3bcd675f4777356a5e4cb5560ce22bdef2438f07` | sprint/2026-09-canonical |
| 2026-09-07T02:31:14Z | `a0471325-e517-43c7-bcf3-0d6dc0c2917d` | `606fcbfd47ee694e96393635153280752c6a352d` | sprint/2026-09-canonical |
| 2026-09-07T02:50:13Z | `41ff8b0e-57ab-472f-8a41-e38c91f600d2` | `7564a14c70d173ddc716bb2db41b99c484f70655` | sprint/2026-09-canonical |
| 2026-09-07T03:05:34Z | `5d0e1340-f464-496e-a1b2-ee0212f6cb34` | `aaeb133bb217832d4d28063a4f58686e90faec2c` | sprint/2026-09-canonical |
| 2026-09-07T03:24:02Z | `b49d6067-012b-41f9-a4d6-73a9fedfdc05` | `e14263ba929c4fffa3738c4eaf530170ece62536` | sprint/2026-09-canonical |
| 2026-09-07T03:59:43Z | `76937649-ce11-4cc3-bcb3-afd9690a6e81` | `9b4bf1bd6b593accdf85d74a408f7b65bb36a147` | sprint/2026-09-canonical |
| 2026-09-07T04:57:26Z | `ad37605b-bb08-4734-9e6a-74fafaeaa954` | `6cbdcb4361eecc0be9f7766d79820a439b681720` | sprint/2026-09-canonical |
| 2026-09-07T04:59:43Z | `7067cac8-b63e-4fb8-aaf9-c05a1e0a4379` | `33c7f7a8fe7e8486e42a929fb619cf6cab272a6d` | sprint/2026-09-canonical |
| 2026-09-07T05:02:06Z | `51ed1875-9a7d-441c-b842-63b3cf431739` | `cfe30d13b685d5933cef37c1e87aaa9293878fce` | sprint/2026-09-canonical |
| 2026-09-07T05:53:23Z | `cf4d54d0-3818-4030-96d1-3c19ed95567d` | `717c4b7e7383354a2bfe9a2b2e88f52038bdd868` | sprint/2026-09-canonical |
| 2026-09-07T07:44:04Z | `315cce74-477c-440a-8e90-2dd5fe342727` | `c94e39649b4e849bad95e883d0d42e516582bc4d` | sprint/2026-09-canonical |
