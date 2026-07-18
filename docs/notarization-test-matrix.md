# Notarization Lane — Test Matrix (merge minimum, per XX control-plane review)

Each test maps to a hard constraint. All must pass before merge.

## Constraint 1: source = asset snapshot + ETag conditional read

| # | Test | Expected |
|---|------|----------|
| 1.1 | POST without `asset_id` when build has multiple darwin installables | 409 "ambiguous; specify asset_id" |
| 1.2 | POST without `asset_id` when build has exactly one darwin installable | succeeds (auto-select) |
| 1.3 | POST with `asset_id` belonging to a different build | 404 |
| 1.4 | POST with non-darwin platform asset | 400 (whitelist) |
| 1.5 | POST with filetype not in (zip/dmg/pkg) | 400 |
| 1.6 | DB `file_hash` != computed SHA from R2 bytes | fail closed, 500, error logged |
| 1.7 | R2 object overwritten between HEAD (ETag/size) and byte-read for SHA compute | fail closed (ETag mismatch on conditional read) |
| 1.8 | R2 object overwritten between SHA compute and S3 upload | fail closed (ETag mismatch on second conditional read before upload) |
| 1.9 | Apple request uses computed_sha256, not DB file_hash (fuzz: swap DB value) | Apple receives computed value |

## Constraint 2: logical + append-only attempts, idempotency

| # | Test | Expected |
|---|------|----------|
| 2.1 | Concurrent POST for same (app, asset, SHA) while InProgress | both return same logical_id + attempt_id |
| 2.2 | POST for same (app, asset, SHA) after Accepted | return existing result, no new Apple submission, `idempotent: true` |
| 2.3 | POST for same (app, asset, SHA) after Invalid | new attempt (attempt_no increments), new Apple submission |
| 2.4 | POST for same (app, asset, SHA) after Rejected | new attempt |
| 2.5 | POST for same (app, asset, SHA) after error (infra) | new attempt |
| 2.6 | S3 upload uncertain outcome (network timeout mid-PUT) | reconcile original submission_id via status poll; do NOT create new submission |
| 2.7 | Temp AWS creds / sessionToken in D1 | not stored (grep all columns) |
| 2.8 | developerLogUrl in D1 / operation output / audit / API response | not present anywhere |

## Constraint 3: app ownership proven locally

| # | Test | Expected |
|---|------|----------|
| 3.1 | GET /apps/A/notarizations/submission-of-app-B | 404 before any Apple API call |
| 3.2 | GET /apps/A/notarizations/nonexistent-id | 404, no Apple call |
| 3.3 | GET with valid app + submission | normalized state + log summary only; no raw Apple response passthrough |
| 3.4 | Full log retained (if implemented) | stored in private R2 object, viewer-audited, size-capped; short-lived URL not returned |

## Constraint 4: ready_for_staple triple closure

| # | Test | Expected |
|---|------|----------|
| 4.1 | status=Accepted + log fetched + jobId==submission_id + log SHA==source SHA | ready_for_staple=true |
| 4.2 | status=Accepted + log fetch 404 | ready_for_staple=false (log_fetched=0) |
| 4.3 | status=Accepted + log jobId != submission_id | ready_for_staple=false |
| 4.4 | status=Accepted + log SHA != source computed_sha256 | ready_for_staple=false, SHA_BINDING_MISMATCH error class |
| 4.5 | status=InProgress | ready_for_staple=false |
| 4.6 | status=unknown/null (Apple adds new enum) | ready_for_staple=false, treated as in_progress |
| 4.7 | S3 PUT success ETag | recorded in attempt but NOT treated as content hash |

## Error classification (per XX: 401/403/7000 distinct)

| # | Test | Expected error_class |
|---|------|---------------------|
| 5.1 | Apple returns 401 on POST submissions | NOTARY_AUTH_INVALID |
| 5.2 | Apple returns 403 on POST submissions | NOTARY_ROLE_INSUFFICIENT |
| 5.3 | Apple returns 7000 (team not configured for notarization) in terminal Rejected | NOTARY_TEAM_NOT_CONFIGURED (not role error) |
| 5.4 | Apple returns Rejected (non-7000) | error_class=UNKNOWN or specific, status_state=rejected |
| 5.5 | Apple returns 500/502/503 | APPLE_REQUEST_FAILED, attempt error, retryable |

## Production happy-path declaration discipline
- Until one real Accepted + log-SHA closure has been observed in production, the lane
  is declared "broker/control-plane ready" only, NOT "production happy path proven."
- This is a documentation/communication constraint, not a test case.
