# The public branch — verification, the safe removal, and what cannot be undone

`sprint/2026-09-canonical` exists on **both** the public backend repository and
the private mirror.

    origin  github.com/DCSAITechnologies/dcs-games-backend                 PUBLIC
    bank    github.com/DCSAITechnologies/dcs-games-backend-sprint-sep2026  PRIVATE

**Nothing here has been deleted.** The founder controls that decision and it has
not been authorised. What follows is the preparation.

---

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
