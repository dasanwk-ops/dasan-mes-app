# Firebase Emulator validation - 2026-09-12

## Scope

Branch: `mes-safety-test` only.
Tested commit: `277bd69db72f88eb752ec246dff5c09ae6e9c763`.
Workflow run: https://github.com/dasanwk-ops/dasan-mes-app/actions/runs/34696803739
Job: `103561567573`.
Result: completed successfully. The decoded job log contains all three PASS messages below and process exit code 0.

The workflow starts the official Authentication and Firestore emulators using project `demo-dasan-mes`, with synthetic data only. It does not authenticate a production service account. This is not a live factory data check, a backup, or approval to deploy to production.

## Results verified from the job log

1. `PASS native Firestore duplicate completion`
   - Two concurrent attempts to complete the same synthetic inspection WIP produce exactly one successful operation.
2. `PASS native permission-denied rolls back stock, audit and control`
   - An intentionally denied write rejects the transaction; the test explicitly verifies that WIP data and audit count remain unchanged. The control document shares the same transaction, but this particular test does not separately assert its contents after failure.
3. `PASS native archive plus stale-write rejection`
   - Cancelling synthetic WIP removes the active record, preserves its quantity in the archive, and rejects a completion based on the old WIP.

The initial run `34696629460` failed before these tests because its Java runtime was below the version accepted by the installed Firebase CLI. The workflow was updated to select Temurin Java 21, and the second run above succeeded. No application quantity or process logic was changed by this workflow fix.

The earlier 102 memory-driver tests are a separate result; this workflow runs only `tests/emulator/run-native.mjs`, not that entire suite.

## Limitations and remaining checks

- `tests/emulator/firestore.rules` is a permissive authenticated-user fixture with an intentional denied collection. It is NOT the factory's actual authorization policy and MUST NOT be deployed as production rules.
- This run does not certify production IAM, operator/admin separation, browser reconnect behavior, the physical printer, Apps Script, or all old-client interactions.
- Dependency installation reported 30 vulnerabilities (including 14 high) before adding the test CLI and 36 afterwards. These are package-audit totals, not an assessment of exploitability in the deployed app. Dependency paths and affected usage still need review. No forced dependency upgrades were applied.
- Existing manifests use floating dependency versions and no committed dependency lockfile was added in this change. Reproducible builds remain a follow-up.

## Production read status

The separate OIDC identity test succeeded previously. However, proposed workflows for live Firestore export/diagnostics were rejected by the tool safety check and were not created. No fresh factory export was obtained in this session. Identity authentication must not be reported as successful end-to-end production data retrieval or proof of read-only IAM scope.

Use a user-provided export through the established MES export function for further inventory reconciliation until an approved live-read integration is available. Do not loosen IAM, Firestore rules or authentication to get around the blocked automated transfer.

Production `main` was checked and remained `d040780247aa5ada6d420ac6900892a96ad72f82`; no production database, rule, environment, or printer was modified by these emulator checks.
