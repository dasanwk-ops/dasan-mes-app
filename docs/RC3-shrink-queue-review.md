# RC3 - shrinkage connections and preserved queue selection

Date: 2026-09-11
Scope: mes-safety-test only. This is not production approval and is not a live stock correction.
Baseline: 3341853cc734282d5be96000f46b44a7a7ca97cc (RC2).

## What this change does

- Add a read-only connection review panel to the shrinkage screen.
- Show missing WIP references, partially linked quantities, unexpected product/LOT/position links, duplicate batch identities, and cross-batch/cross-furnace references.
- Count missing pre/post measurement entries separately. A correct quantity/link does NOT mean measurements have been performed or quality approval has been granted.
- Validate an existing queued batch against latest source records before making it active.
- Preserve the previous active batch, its raw measurement inputs, and the remaining queue. No WIP quantity or process change is performed by queue selection.
- Record the queue before/after and selected batch through the existing audited transaction wrapper.
- Reject stale queue selections, duplicated batch IDs, moved/missing WIPs, mismatched quantities and conflicting furnace assignments.
- Disable queued selection buttons when the current read-only review finds a structural mismatch. The transaction independently rechecks the latest state.

This is NOT an automatic stale-record deletion, WIP reconstruction, measurement import or completion bypass. The existing mixed-data isolation/recovery actions are not changed or approved for indiscriminate use by this patch.

## Existing production behavior

The inspected main branch already has a `selectBatch` action that swaps an existing queued batch into the active position and retains the old active batch in the queue. New heat-completion work can therefore be selected without erasing historical work. That does not fix old incomplete records; actual measurements and source evidence are still required.

## Validation completed

- The 80 existing RC1/RC2 synthetic tests plus 22 new queue/review tests passed: 102 tests, 0 failures.
- GitHub preparation run 34606572487 succeeded. Its decoded job log confirms all 102 tests and the exact prepared source blob hashes.
- Module syntax validation passed in that run.
- Local JSX/source inspection passed with zero unresolved/duplicate identifiers. There were 36 other untyped JavaScript diagnostics; this is not a full type-check pass.
- The local minimal-hook smoke harness constructed 15 screens and passed the retained RC2 display checks. It is not a real browser/DOM/effect integration test.
- A private local in-memory simulation based on an uploaded historical export preserved old queue records while selecting newly completed heat work. No uploaded production export, identifying records or private test outputs are included in this public repository.

Prepared App.js blob: 6b256917f6b9634e06c2fddf45c15db0424a03aa
Prepared render-smoke blob: 56af8f425e3ba645c66b7fa8967546e3ea5114c8

The one-time preparation workflow/script only created tested Git blobs and is removed from the final tree. The retained safety workflow is read-only and uses synthetic data. Vercel build/deployment status is checked separately after the final commit.

## Still required before production adoption

- Real browser verification of the new panel and queue selection.
- Firebase emulator and security-rule checks for the full RC1/RC2/RC3 release.
- Review of compatibility with all old clients and the physical label-printing worker.
- A fresh authoritative data export before any live repair. Historical exports are not proof of present live state.
- Evidence for missing measurements, manufacturing dates and actual completed process stages. Never populate them from guessed defaults or move lots forward just to make totals match.

No main ref, production database, Firebase rule, environment variable or printer was changed for this RC3 patch.
