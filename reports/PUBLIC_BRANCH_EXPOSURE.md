# The public branch — DELETED 7 Sep 2026

**`sprint/2026-09-canonical` has been deleted from the PUBLIC backend
repository**, on founder authorisation. The private mirror is untouched and
holds the complete history.

    origin  github.com/DCSAITechnologies/dcs-games-backend                 PUBLIC   branch REMOVED
    bank    github.com/DCSAITechnologies/dcs-games-backend-sprint-sep2026  PRIVATE  branch INTACT

## What was done

    git push origin --delete sprint/2026-09-canonical

behind a pre-flight that refused unless the private mirror already contained the
public tip. No history was rewritten, no tag was deleted, no force-push was
used, `main` and `recovery/prod-schema-lineage` were not touched.

## Verified afterwards

| check | result |
| --- | --- |
| `sprint/2026-09-canonical` on public origin | **absent** |
| public `main` | `e979d87b26c1`, unchanged |
| public `recovery/prod-schema-lineage` | `9937f2247c45`, unchanged |
| private mirror branch | present, 207 commits |
| checkpoint tag `DCS_GAMES_V3_CHECKPOINT_07SEP2026` | on the mirror; never on public |
| frontend repo | `03e8e1f`, private, untouched |
| netcode repo | pinned `49f10353`, not modified |
| staging deployment | unchanged by the deletion |
| Supabase migrations | none run; ledger still at v13 |
| payments | dark |
| local branches and tags | unchanged |

## One thing that happened and is worth recording

After the first deletion, a routine `git push origin HEAD` **recreated the
branch**, because the local branch still tracked the public remote. It was
deleted again, and the branch's upstream now points at the PRIVATE mirror
(`bank/sprint/2026-09-canonical`), so an unqualified push goes to the private
copy rather than re-publishing.

That is worth stating plainly rather than quietly correcting: a deletion is not
self-sustaining while the tooling still points at the thing deleted.

## What this does NOT do — no cryptographic erasure is claimed

Deleting the branch reduces **current public discoverability**. It does not
retract anything already taken:

1. **A clone or fetch already made is a complete copy of the history.** Nothing
   on GitHub's side reaches into it.
2. **Unreferenced objects can stay reachable by SHA on GitHub for a period**
   after the ref is gone. A recorded commit URL may keep resolving. Only GitHub
   Support can force immediate garbage collection, and that must be requested
   explicitly.
3. **Forks keep the objects.** They share the repository network.
4. **Search engines, code-scanning services and archival mirrors may have
   indexed it.** Deletion issues no retraction to any of them.
5. **Pull-request refs (`refs/pull/*`) are not removed with a branch.** GitHub
   offered a PR on every push to this branch; if one was opened its head ref
   persists independently.

**Treat every vulnerability reproduction that was on that branch as already
disclosed.** The deletion stops the exposure growing; it is not a reason to slow
the production cutover, because the reproductions describe defects that are
FIXED in this branch and still live in the production build. Shipping the fixes
is what closes the exposure.

## What was exposed while it was public

    178 commits ahead of public main
    8   test files carrying working vulnerability reproductions
        (security-regression, route-authz, supabase-paths, lead-review*)
    6   commit subjects naming a security defect in their first line

Not exposed: the private mirror, the checkpoint tag, the frontend repository
(private), any secret — the secret scan reads CLEAN across 189 files, and no
service-role key, anon key or production project ref appears in the branch.

## Restoring it, if that is ever wanted

    git push origin HEAD:refs/heads/sprint/2026-09-canonical

The branch is recreated from the local checkout, which is identical to the
mirror. Deletion is reversible on the remote; what already left the remote is
not.

---

# Appendix — the pre-deletion safety proof

## 1. The private mirror holds the complete history — verified

    local commits on branch          199
    mirror commits on branch         199
    local HEAD == mirror HEAD        yes
    commits in local not in mirror   0
    tags on the mirror               DCS_GAMES_V3_CHECKPOINT_07SEP2026
    tags on the public origin        none

The checkpoint tag exists only on the private mirror. Deleting the public branch
therefore removes no tag and no commit that is not held privately.

Re-verify at any time:

    git ls-remote bank  refs/heads/sprint/2026-09-canonical
    git ls-remote origin refs/heads/sprint/2026-09-canonical
    git rev-list --count bank/sprint/2026-09-canonical..HEAD     # must be 0

## 2. Rollback bundles restore — verified, not merely created

    backend-gb-fc02084-20260907T053207Z.bundle    sha256 75635f4b45a6…
    frontend-live-03e8e1f-20260907T053207Z.bundle sha256 cd8a8ad4e334…

A clone from each was performed and inspected:

    backend   sprint/2026-09-canonical @ fc02084 · 199 commits · 13 migrations · 2 tags
    frontend  main @ 03e8e1f · 25 commits · 146 pages

So the history survives the loss of BOTH remotes, not just one.

## 3. The exact deletion, if it is authorised

```sh
cd "…/dcs-games-6month-deploy/gb"

# 1. Refuse to proceed unless the mirror is complete. This is the whole safety
#    argument; do not skip it because it passed an hour ago.
test "$(git ls-remote bank   refs/heads/sprint/2026-09-canonical | cut -f1)" \
   = "$(git ls-remote origin refs/heads/sprint/2026-09-canonical | cut -f1)" \
  && echo "mirror is in sync — safe to proceed" \
  || { echo "REFUSING: the mirror is NOT in sync"; exit 1; }

# 2. Delete the branch from the PUBLIC repository only.
git push origin --delete sprint/2026-09-canonical
```

### Verify afterwards

```sh
git ls-remote --heads origin | grep sprint/2026-09-canonical   # expect: no output
git ls-remote --heads bank   | grep sprint/2026-09-canonical   # expect: still there
git ls-remote --tags  bank   | grep CHECKPOINT                 # expect: still there
```

And confirm nothing local was affected:

```sh
git status --porcelain      # expect: clean
git rev-parse HEAD          # expect: unchanged
```

### If it must be undone

```sh
git push origin HEAD:refs/heads/sprint/2026-09-canonical
```

The branch is recreated from the local checkout, which is identical to the
mirror. Deletion is therefore reversible **on the remote**; it is what has
already left the remote that is not.

---

## 4. What deletion CANNOT undo — stated plainly

Deleting a branch stops future access through that ref. It does not retract
anything that has already been taken. Specifically:

1. **Anyone who has already cloned or fetched it has a complete copy.** A git
   clone is the whole history, not a view of it. Nothing on GitHub's side can
   reach into it.
2. **Unreferenced objects can remain reachable by SHA on GitHub for a period
   after the ref is gone.** A commit URL someone recorded may keep resolving.
   Only GitHub Support can force immediate garbage collection, and that request
   has to be made explicitly.
3. **Forks, if any exist, keep the objects.** They live in the same repository
   network, and deleting a branch in the upstream does not remove them from a
   fork.
4. **Search engines, code-scanning services and archival mirrors may have
   indexed it.** Deletion does not issue a retraction to any of them.
5. **Pull request refs (`refs/pull/*`) are not deleted with a branch.** GitHub
   offered a PR for this branch on every push, so check whether one was opened;
   if it was, its head ref persists independently.

### The honest conclusion

Treat every vulnerability reproduction on that branch as **already disclosed**,
and prioritise accordingly. The value of deleting the branch is that it stops
the exposure growing — it is not a reason to slow the cutover down. The
reproductions describe defects that are FIXED in this branch and still live in
the production build, so the thing that actually closes the exposure is shipping
the fixes.

## 5. What was actually exposed

    178 commits ahead of public main
    8   test files carrying working vulnerability reproductions
        (security-regression, route-authz, supabase-paths, lead-review*)
    6   commit subjects naming a security defect in their first line

Not exposed: the private mirror, the checkpoint tag, the frontend repository
(which is private), any secret (the secret scan reads CLEAN across 189 files),
and any credential — no service-role key, anon key or production project ref
appears in the branch.
