# RC2 - heat-treatment status display

Date: 2026-09-11
Scope: `mes-safety-test` only. Not an approval to deploy RC1/RC2 to production.
Baseline: `d5ca22dcac5020e9282d12d9c192f9954a1e73c1` (RC1 upload).

## Reported defect

The dashboard and the current option in its administrator editor showed heat-treatment waiting even after the assigned furnace started. The underlying WIP remains `step5` during heating by design; changing that stored step would interfere with existing transition guards.

## Change

Add a pure read-only `getWipProcessStatus` helper and use it in both dashboard displays:

- No current assignment: 열처리 대기.
- Fully assigned, furnace stopped: 전기로 배정 (1호기).
- Fully assigned, furnace running: 열처리 중 (1호기).
- Furnace 2 is named as 2호기; historical furnaceSlots alone do not imply current heating.
- Quantity mismatch, multiple furnace assignments or an unknown running flag: 열처리 배정 확인 필요.
- A WIP already moved to another step continues to display that step.

Only current equipment slotData with the same WIP document ID is used. LOT text alone is not used as a join. The helper does not write any database data, modify currentStep, adjust quantities or change runtime mode. The editor option value remains the original stored step.

## Validation completed during preparation

- Node synthetic safety tests: 80 passed, 0 failed (62 existing + 18 display regression tests).
- Syntax/name inspection: no parse errors or unresolved/duplicate identifiers; other untyped JavaScript diagnostics remain, so this is not a full type-check pass.
- Minimal-hook component-construction tests: 15 screen functions and dashboard navigation passed.
- Dashboard badge and administrator current-option tests passed for assigned/stopped and running states.
- The baseline-guarded source patch and synthetic tests also succeeded in GitHub Actions before the tested blobs were used in the final commit.

These checks are not a substitute for real React/browser, Firebase emulator, access-rule, tablet or physical printer tests. Vercel build status is checked separately after this commit.

## Operational boundaries

- No changes to main, production data, stocktake correction tools or Firebase settings.
- The RC1 synthetic demo policy and all operation guards are retained unchanged.
- A temporary preparation job created tested Git blobs only; it never moved a branch. Its workflow and script are removed in this final commit.
- The remaining GitHub workflow has contents:read and runs synthetic tests on mes-safety-test only. It has no write steps and does not inject Firebase credentials.
- Earlier RC1 reports and checksums remain historical RC1 records; this document records the RC2 delta.

## Follow-up

No more testing is requested tonight. At the next session, optionally verify MIX-DEMO-005 changes from waiting to assigned to heating in the dashboard. Production approval remains a separate decision; the full RC1 safety release still needs its remaining integration/security checks.
