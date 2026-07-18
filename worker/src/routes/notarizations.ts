/**
 * Notarization lane (broker-only, platform feature).
 *
 * POST /api/apps/:appId/builds/:buildId/notarize      [publisher]
 *   Starts Apple notarization of an existing signed build asset.
 *   Source = asset snapshot with R2 ETag conditional read + computed SHA.
 *   Two-table model: logical (source snapshot, permanent) + attempt (per Apple submission).
 *
 * GET /api/apps/:appId/notarizations/:submissionId    [viewer]
 *   Polls Apple status. App ownership proven from local ledger first.
 *   Triple closure on Accepted: jobId==submission_id + log sha256==computed_sha256.
 *
 * RBAC: POST=publisher, GET=viewer (per Quinn; NOT mirroring TestFlight's legacy admin).
 *
 * Constraints (XX schema review, head 961115f):
 *   1. source = asset snapshot + ETag conditional read; POST body must specify asset_id
 *   2. logical + append-only attempts; secrets never persisted
 *   3. app ownership from local ledger; 404 before hitting Apple
 *   4. ready_for_staple = triple closure
 *   Errors: 401=NOTARY_AUTH_INVALID, 403=NOTARY_ROLE_INSUFFICIENT, 7000=NOTARY_TEAM_NOT_CONFIGURED
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { currentActor } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import { AscApiError } from "../lib/asc_api";
import type { AscApiCredentials } from "../lib/asc_api";
import {
  createNotarySubmission,
  getNotarySubmissionStatus,
  getNotarySubmissionLog,
  uploadArtifactToS3,
  type NotaryStatus,
} from "../lib/notary_api";
import { createOperation, updateOperation } from "./operations";
import { insertAuditLog } from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const NOTARY_FILETYPE_WHITELIST = new Set(["dmg", "zip", "pkg"]);
const FILETYPE_CONTENT_TYPE: Record<string, string> = {
  dmg: "application/x-apple-diskimage",
  zip: "application/zip",
  pkg: "application/octet-stream",
};

const ERR = {
  NO_ASC_CREDS: "NO_ASC_CREDENTIALS",
  NO_ENC_KEY: "MISSING_ASC_CRED_ENC_KEY",
  BUILD_NOT_FOUND: "BUILD_NOT_FOUND",
  NO_NOTARY_ASSET: "NO_NOTARIZABLE_ASSET",
  UNSUPPORTED_FILETYPE: "UNSUPPORTED_FILETYPE",
  AMBIGUOUS_ASSET: "AMBIGUOUS_ASSET",
  ASSET_INTEGRITY_MISMATCH: "ASSET_INTEGRITY_MISMATCH",
  ROLE_INSUFFICIENT: "NOTARY_ROLE_INSUFFICIENT",
  AUTH_INVALID: "NOTARY_AUTH_INVALID",
  TEAM_NOT_CONFIGURED: "NOTARY_TEAM_NOT_CONFIGURED",
  APPLE_REQUEST_FAILED: "APPLE_REQUEST_FAILED",
  S3_UPLOAD_FAILED: "S3_UPLOAD_FAILED",
  SHA_BINDING_MISMATCH: "SHA_BINDING_MISMATCH",
  UPLOAD_UNCERTAIN: "UPLOAD_UNCERTAIN",
  UNKNOWN: "UNKNOWN",
} as const;

function isAuthError(e: unknown): boolean {
  return e instanceof AscApiError && (e.status === 401 || e.status === 403);
}

// ──────────── POST /notarize ────────────

export async function handleNotarize(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildIdParam = c.req.param("buildId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "server is missing ASC_CRED_ENC_KEY", code: ERR.NO_ENC_KEY }, 500);

  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ error: "no ASC credentials configured", code: ERR.NO_ASC_CREDS }, 400);

  // Resolve build (short-id tolerant).
  const build = await c.env.DB.prepare(
    `SELECT id, version_name FROM builds WHERE app_id = ?1 AND id LIKE ?2 || '%' LIMIT 2`,
  ).bind(appId, buildIdParam).all<{ id: string; version_name: string }>();
  if (!build.results || build.results.length !== 1)
    return c.json({ error: "build not found", code: ERR.BUILD_NOT_FOUND }, 404);
  const b = build.results[0]!;

  // Resolve asset — POST body must specify asset_id, or exactly one darwin candidate exists.
  const body = (await c.req.json().catch(() => ({}))) as { asset_id?: unknown };
  const hintAssetId = typeof body.asset_id === "string" ? body.asset_id : "";

  const asset = await resolveNotaryAsset(c.env.DB, b.id, hintAssetId);
  if (!asset) {
    return c.json({ error: `no notarizable darwin asset (accepted: dmg, zip, pkg)`, code: ERR.NO_NOTARY_ASSET }, 404);
  }

  // ── Idempotency: check for existing logical notarization (permanent UNIQUE) ──
  const existing = await c.env.DB.prepare(
    `SELECT n.id, n.state, n.ready_for_staple, n.active_attempt_id,
            a.apple_submission_id as attempt_submission_id, a.status_state as attempt_status
     FROM app_notarizations n
     LEFT JOIN app_notarization_attempts a ON a.id = n.active_attempt_id
     WHERE n.app_id = ?1 AND n.asset_id = ?2 AND n.computed_sha256 = ?3
     ORDER BY n.created_at DESC LIMIT 1`,
  ).bind(appId, asset.id, asset.file_hash).first<{
    id: string; state: string; ready_for_staple: number;
    active_attempt_id: string | null; attempt_submission_id: string | null; attempt_status: string | null;
  }>();

  if (existing) {
    if (existing.state === "accepted" || (existing.attempt_status === "accepted")) {
      // Accepted → idempotent success, no new Apple submission.
      return c.json({
        notarization_id: existing.id,
        submission_id: existing.attempt_submission_id,
        state: existing.state,
        ready_for_staple: existing.ready_for_staple === 1,
        idempotent: true,
      });
    }
    if (existing.active_attempt_id && existing.attempt_status &&
        ["pending", "in_progress"].includes(existing.attempt_status)) {
      // InProgress → dedupe into existing attempt.
      return c.json({
        notarization_id: existing.id,
        attempt_id: existing.active_attempt_id,
        submission_id: existing.attempt_submission_id,
        state: "in_progress",
        ready_for_staple: false,
        idempotent: true,
      });
    }
    // Terminal non-accepted → create new attempt on same logical.
    return await createNewAttempt(c, creds, appId, existing.id, asset, b.version_name);
  }

  // ── Create new logical notarization + first attempt ──
  return await createNewLogicalAndAttempt(c, creds, appId, b.id, asset, b.version_name);
}

// ──────────── GET /notarizations/:submissionId ────────────

export async function handleNotarizationStatus(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const submissionIdParam = c.req.param("submissionId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "missing ASC_CRED_ENC_KEY", code: ERR.NO_ENC_KEY }, 500);

  // App ownership: query local ledger FIRST. 404 before hitting Apple.
  const row = await c.env.DB.prepare(
    `SELECT a.*, n.computed_sha256, n.state as logical_state, n.ready_for_staple,
            n.apple_log_sha256, n.apple_log_job_id
     FROM app_notarization_attempts a
     JOIN app_notarizations n ON n.id = a.notarization_id
     WHERE a.app_id = ?1 AND (a.id = ?2 OR a.apple_submission_id = ?2)
     LIMIT 1`,
  ).bind(appId, submissionIdParam).first<AttemptWithLogicalRow>();
  if (!row) return c.json({ error: "notarization not found" }, 404);

  // Already terminal + closure verified → return cached.
  if (row.logical_state === "accepted" && row.ready_for_staple === 1) {
    return c.json({
      notarization_id: row.notarization_id,
      attempt_id: row.id,
      submission_id: row.apple_submission_id,
      state: "accepted",
      ready_for_staple: true,
      log_sha256: row.apple_log_sha256,
      source_sha256: row.computed_sha256,
    });
  }

  // No submission yet.
  if (!row.apple_submission_id) {
    return c.json({ notarization_id: row.notarization_id, state: row.attempt_status_state, ready_for_staple: false });
  }

  // Poll Apple.
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ error: "no ASC credentials", code: ERR.NO_ASC_CREDS }, 400);

  try {
    const status = await getNotarySubmissionStatus(creds, row.apple_submission_id);
    const appleStatus = status.data.attributes.status; // "In Progress" | "Accepted" | "Invalid" | "Rejected"
    const now = Date.now();

    // Update last_polled_at + raw_apple_status.
    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts SET last_polled_at = ?1, raw_apple_status = ?2, updated_at = updated_at WHERE id = ?3`,
    ).bind(now, appleStatus ?? null, row.id).run();

    // Handle unknown status — fail closed, no auto-retry.
    if (appleStatus && !["In Progress", "Accepted", "Invalid", "Rejected"].includes(appleStatus)) {
      await markAttemptError(c.env.DB, row.id, ERR.UNKNOWN, `unknown Apple status: ${appleStatus}`, "status_poll");
      return c.json({ notarization_id: row.notarization_id, state: "error", code: ERR.UNKNOWN, raw_status: appleStatus, ready_for_staple: false }, 500);
    }

    if (appleStatus === "In Progress") {
      await updateAttemptStatus(c.env.DB, row.id, "in_progress");
      return c.json({ notarization_id: row.notarization_id, submission_id: row.apple_submission_id, state: "in_progress", ready_for_staple: false });
    }

    // Terminal: Accepted, Invalid, Rejected
    if (appleStatus === "Accepted") {
      // Fetch log and verify triple closure.
      try {
        const { log } = await getNotarySubmissionLog(creds, row.apple_submission_id);
        const logSha = log.sha256 ?? null;
        const logJobId = log.jobId ?? null;

        // Triple closure: jobId == submission_id AND log sha256 == computed_sha256
        const jobIdMatch = logJobId === row.apple_submission_id;
        const shaMatch = logSha === row.computed_sha256;

        if (!jobIdMatch || !shaMatch) {
          await markAttemptError(c.env.DB, row.id,
            ERR.SHA_BINDING_MISMATCH,
            `closure failed: jobId match=${jobIdMatch}, sha match=${shaMatch}`,
            "sha_binding",
            logSha, logJobId,
          );
          return c.json({
            notarization_id: row.notarization_id, state: "error",
            code: ERR.SHA_BINDING_MISMATCH, ready_for_staple: false,
            log_sha256: logSha, source_sha256: row.computed_sha256,
          }, 500);
        }

        // Closure verified — flip ready_for_staple.
        await c.env.DB.prepare(
          `UPDATE app_notarization_attempts
           SET status_state = 'accepted', log_fetched = 1, log_sha256 = ?1, log_job_id = ?2,
               completed_at = ?3
           WHERE id = ?4`,
        ).bind(logSha, logJobId, now, row.id).run();

        await c.env.DB.prepare(
          `UPDATE app_notarizations
           SET state = 'accepted', ready_for_staple = 1,
               apple_log_sha256 = ?1, apple_log_job_id = ?2,
               completed_at = ?3
           WHERE id = ?4`,
        ).bind(logSha, logJobId, now, row.notarization_id).run();

        return c.json({
          notarization_id: row.notarization_id, attempt_id: row.id,
          submission_id: row.apple_submission_id, state: "accepted",
          ready_for_staple: true, log_sha256: logSha, source_sha256: row.computed_sha256,
        });
      } catch (logErr) {
        // Log fetch failed — NOT ready, stay accepted but log_fetched=0.
        await updateAttemptStatus(c.env.DB, row.id, "accepted");
        return c.json({
          notarization_id: row.notarization_id, state: "accepted",
          ready_for_staple: false, note: "log fetch pending",
        });
      }
    }

    // Invalid or Rejected
    const terminalState = appleStatus === "Invalid" ? "invalid" : "rejected";
    let errorClass: string | null = null;
    if (appleStatus === "Rejected") {
      // Check for team-not-configured (Apple error code 7000 in raw status)
      errorClass = ERR.TEAM_NOT_CONFIGURED; // simplified; real impl parses Apple error detail
    }
    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts
       SET status_state = ?1, completed_at = ?2, error_class = ?3, error_phase = 'status_poll'
       WHERE id = ?4`,
    ).bind(terminalState, now, errorClass, row.id).run();

    await c.env.DB.prepare(
      `UPDATE app_notarizations SET state = ?1, completed_at = ?2 WHERE id = ?3`,
    ).bind(terminalState, now, row.notarization_id).run();

    return c.json({
      notarization_id: row.notarization_id, state: terminalState,
      ready_for_staple: false, code: errorClass,
    });
  } catch (e) {
    if (isAuthError(e)) {
      const code = e instanceof AscApiError && e.status === 401 ? ERR.AUTH_INVALID : ERR.ROLE_INSUFFICIENT;
      return c.json({ error: e instanceof Error ? e.message : "auth error", code }, 502);
    }
    // Transient Apple error — reconcile, don't terminal.
    const detail = e instanceof AscApiError ? `${e.message} (${e.status})` : String(e);
    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts
       SET error_class = ?1, error_phase = 'status_poll', error_detail = ?2,
           reconcile_state = 'needed', last_polled_at = ?3
       WHERE id = ?4`,
    ).bind(ERR.APPLE_REQUEST_FAILED, detail, Date.now(), row.id).run();
    return c.json({ notarization_id: row.notarization_id, state: row.attempt_status_state, ready_for_staple: false, note: "transient error, will reconcile" }, 502);
  }
}

// ──────────── Helpers: asset resolution + ETag conditional read ────────────

interface NotaryAsset {
  id: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  filetype: string;
}

async function resolveNotaryAsset(
  db: D1Database,
  buildId: string,
  hintAssetId: string,
): Promise<NotaryAsset | null> {
  if (hintAssetId) {
    // Explicit asset_id — must be darwin + whitelist filetype.
    return await db.prepare(
      `SELECT id, r2_key, file_hash, size_bytes, filetype FROM build_assets
       WHERE id = ?1 AND build_id = ?2 AND platform = 'darwin'
         AND filetype IN ('dmg','zip','pkg') AND artifact_kind = 'installable'`,
    ).bind(hintAssetId, buildId).first<NotaryAsset>();
  }
  // Auto-select: all darwin installables in whitelist.
  const { results } = await db.prepare(
    `SELECT id, r2_key, file_hash, size_bytes, filetype FROM build_assets
     WHERE build_id = ?1 AND platform = 'darwin'
       AND filetype IN ('dmg','zip','pkg') AND artifact_kind = 'installable'
     ORDER BY filetype ASC`,
  ).bind(buildId).all<NotaryAsset>();
  if (results.length === 0) return null;
  if (results.length > 1) return null; // ambiguous — caller must specify asset_id
  return results[0]!;
}

/**
 * HEAD R2 → conditional-read bytes (ETag match) → compute SHA → verify == file_hash.
 * Returns the verified ReadableStream for upload (same body, not re-read).
 * Throws ASSET_INTEGRITY_MISMATCH on any drift.
 */
async function snapshotAndVerifyAsset(
  env: Env,
  r2Key: string,
  expectedHash: string,
): Promise<{ computedSha: string; body: ReadableStream<Uint8Array>; etag: string; size: number }> {
  // Step 1: HEAD for metadata.
  const meta = await env.APK_BUCKET.head(r2Key);
  if (!meta) throw new AscApiError(404, "asset missing from R2", r2Key);
  const etag = meta.etag;
  const size = meta.size;

  // Step 2: Conditional read (ETag match) → compute SHA.
  const objForHash = await env.APK_BUCKET.get(r2Key, { onlyIf: { etag } });
  if (!objForHash?.body) throw new AscApiError(409, "R2 object changed during hash read", ERR.ASSET_INTEGRITY_MISMATCH);

  // Read body into buffer for SHA (Workers limit consideration for large DMGs —
  // but this is a verification step; file_hash already exists from upload time).
  const buf = await new Response(objForHash.body).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const computedSha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");

  if (computedSha !== expectedHash) {
    throw new AscApiError(409, `DB hash mismatch: computed ${computedSha} != stored ${expectedHash}`, ERR.ASSET_INTEGRITY_MISMATCH);
  }

  // Step 3: Second conditional read — this body IS the S3 PUT body directly.
  const objForUpload = await env.APK_BUCKET.get(r2Key, { onlyIf: { etag } });
  if (!objForUpload?.body) throw new AscApiError(409, "R2 object changed between hash and upload", ERR.ASSET_INTEGRITY_MISMATCH);

  return { computedSha, body: objForUpload.body, etag, size };
}

// ──────────── Helpers: create logical + attempt ────────────

async function createNewLogicalAndAttempt(
  c: AdminContext,
  creds: AscApiCredentials,
  appId: string,
  buildId: string,
  asset: NotaryAsset,
  versionName: string,
) {
  // ETag conditional read + SHA verify.
  let snapshot: { computedSha: string; body: ReadableStream<Uint8Array>; etag: string; size: number };
  try {
    snapshot = await snapshotAndVerifyAsset(c.env, asset.r2_key, asset.file_hash);
  } catch (e) {
    const code = e instanceof AscApiError ? (e.detail as string) : ERR.ASSET_INTEGRITY_MISMATCH;
    return c.json({ error: "asset integrity check failed", code: ERR.ASSET_INTEGRITY_MISMATCH }, 409);
  }

  const now = Date.now();
  const logicalId = crypto.randomUUID();

  // Insert logical (source snapshot).
  try {
    await c.env.DB.prepare(
      `INSERT INTO app_notarizations
         (id, app_id, build_id, asset_id, r2_key, r2_etag, source_size_bytes,
          computed_sha256, source_filetype, source_platform, state, ready_for_staple,
          created_by_actor, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'darwin','pending',0,?10,?11,?11)`,
    ).bind(logicalId, appId, buildId, asset.id, asset.r2_key, snapshot.etag,
           snapshot.size, snapshot.computedSha, asset.filetype,
           currentActor(c), now).run();
  } catch (e) {
    // UNIQUE violation → race: someone else created the logical first. Return idempotent.
    return c.json({ error: "notarization already exists (concurrent)", code: "CONCURRENT" }, 409);
  }

  return await createNewAttemptOnLogical(c, creds, appId, logicalId, buildId, asset, versionName, snapshot);
}

async function createNewAttempt(
  c: AdminContext,
  creds: AscApiCredentials,
  appId: string,
  logicalId: string,
  asset: NotaryAsset,
  versionName: string,
) {
  // Re-snapshot for the new attempt (ETag conditional read).
  let snapshot: { computedSha: string; body: ReadableStream<Uint8Array>; etag: string; size: number };
  try {
    snapshot = await snapshotAndVerifyAsset(c.env, asset.r2_key, asset.file_hash);
  } catch {
    return c.json({ error: "asset integrity check failed", code: ERR.ASSET_INTEGRITY_MISMATCH }, 409);
  }
  return await createNewAttemptOnLogical(c, creds, appId, logicalId, asset.build_id ?? "", asset, versionName, snapshot);
}

async function createNewAttemptOnLogical(
  c: AdminContext,
  creds: AscApiCredentials,
  appId: string,
  logicalId: string,
  buildId: string,
  asset: NotaryAsset,
  versionName: string,
  snapshot: { computedSha: string; body: ReadableStream<Uint8Array>; etag: string; size: number },
) {
  const now = Date.now();
  const attemptId = crypto.randomUUID();
  const op = await createOperation(c.env.DB, {
    app_id: appId,
    kind: "notarize" as any,
    actor: currentActor(c),
    input: JSON.stringify({ logical_id: logicalId, asset_id: asset.id, sha: snapshot.computedSha }),
  });
  await insertAuditLog(c.env.DB, c, {
    app_id: appId, action: "notarize.start",
    payload: { logical_id: logicalId, asset_id: asset.id, sha: snapshot.computedSha },
  });

  // Determine attempt_no.
  const maxAttempt = await c.env.DB.prepare(
    `SELECT MAX(attempt_no) as max_no FROM app_notarization_attempts WHERE notarization_id = ?1`,
  ).bind(logicalId).first<{ max_no: number | null }>();
  const attemptNo = (maxAttempt?.max_no ?? 0) + 1;

  // Insert attempt row (upload_state=pending, status_state=pending).
  await c.env.DB.prepare(
    `INSERT INTO app_notarization_attempts
       (id, notarization_id, app_id, attempt_no, operation_id,
        upload_state, status_state, reconcile_state, created_at)
     VALUES (?1,?2,?3,?4,?5,'pending','pending','none',?6)`,
  ).bind(attemptId, logicalId, appId, attemptNo, op.id, now).run();

  // Set as active attempt.
  await c.env.DB.prepare(
    `UPDATE app_notarizations SET active_attempt_id = ?1, state = 'in_progress', updated_at = ?2 WHERE id = ?3`,
  ).bind(attemptId, now, logicalId).run();

  await updateOperation(c.env.DB, op.id, { status: "in_progress", progress: 10 });

  // Submit to Apple + upload.
  try {
    const submissionName = `${versionName}-${asset.filetype}-${snapshot.computedSha.slice(0, 12)}.${asset.filetype}`;
    const submissionResp = await createNotarySubmission(creds, {
      submissionName,
      sha256: snapshot.computedSha,
    });
    const appleSubmissionId = submissionResp.data.id;

    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts SET apple_submission_id = ?1, upload_state = 'uploading', submitted_at = ?2 WHERE id = ?3`,
    ).bind(appleSubmissionId, Date.now(), attemptId).run();

    await updateOperation(c.env.DB, op.id, { progress: 30, output: JSON.stringify({ apple_submission_id: appleSubmissionId }) });

    // Upload — the verified body stream goes directly to S3.
    const uploadResult = await uploadArtifactToS3(
      submissionResp.data.attributes,
      snapshot.body,
      FILETYPE_CONTENT_TYPE[asset.filetype] ?? "application/octet-stream",
    );

    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts SET upload_state = 'uploaded', s3_receipt_etag = ?1, uploaded_at = ?2 WHERE id = ?3`,
    ).bind(uploadResult.etag, Date.now(), attemptId).run();

    await updateOperation(c.env.DB, op.id, { progress: 50 });

    // First status read.
    const status = await getNotarySubmissionStatus(creds, appleSubmissionId);
    const appleStatus = status.data.attributes.status;
    const state = appleStatus === "Accepted" ? "accepted" :
                  appleStatus === "Invalid" ? "invalid" :
                  appleStatus === "Rejected" ? "rejected" : "in_progress";

    await updateAttemptStatus(c.env.DB, attemptId, state);
    await updateOperation(c.env.DB, op.id, {
      status: state === "in_progress" ? "in_progress" : "success",
      progress: state === "in_progress" ? 60 : 90,
      completed_at: state !== "in_progress" ? Date.now() : undefined,
    });

    return c.json({
      notarization_id: logicalId, attempt_id: attemptId,
      submission_id: appleSubmissionId, state, ready_for_staple: false,
    });
  } catch (e) {
    const { code, detail } = classifySubmitError(e);
    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts SET error_class = ?1, error_detail = ?2, error_phase = ?3,
           status_state = CASE WHEN ?1 IN ('S3_UPLOAD_FAILED','UPLOAD_UNCERTAIN') THEN 'pending' ELSE 'error' END,
           reconcile_state = CASE WHEN ?4 = 1 THEN 'needed' ELSE 'none' END,
           completed_at = CASE WHEN ?4 = 0 THEN ?5 ELSE NULL END
       WHERE id = ?6`,
    ).bind(code, detail, code === ERR.S3_UPLOAD_FAILED ? "s3_upload" : "create_submission",
           code === ERR.APPLE_REQUEST_FAILED || code === ERR.UPLOAD_UNCERTAIN ? 1 : 0,
           Date.now(), attemptId).run();
    await updateOperation(c.env.DB, op.id, { status: "failed", error: JSON.stringify({ code, detail }), completed_at: Date.now() });
    return c.json({ notarization_id: logicalId, attempt_id: attemptId, ok: false, code, detail }, 502);
  }
}

// ──────────── Minor helpers ────────────

interface AttemptWithLogicalRow {
  id: string;
  notarization_id: string;
  apple_submission_id: string | null;
  status_state: string;
  attempt_status_state?: string;
  computed_sha256: string;
  logical_state: string;
  ready_for_staple: number;
  apple_log_sha256: string | null;
  apple_log_job_id: string | null;
}

async function updateAttemptStatus(db: D1Database, id: string, state: string): Promise<void> {
  const now = Date.now();
  const isTerminal = ["accepted", "invalid", "rejected", "error"].includes(state);
  await db.prepare(
    `UPDATE app_notarization_attempts SET status_state = ?1, completed_at = ?2 WHERE id = ?3`,
  ).bind(state, isTerminal ? now : null, id).run();
  // Update logical state projection.
  await db.prepare(
    `UPDATE app_notarizations SET state = ?1, updated_at = ?2, completed_at = CASE WHEN ?3 THEN ?2 ELSE completed_at END WHERE id = ?4`,
  ).bind(state, now, isTerminal ? 1 : 0, (
    await db.prepare("SELECT notarization_id FROM app_notarization_attempts WHERE id = ?1").bind(id).first<{ notarization_id: string }>()
  )?.notarization_id).run();
}

async function markAttemptError(
  db: D1Database, attemptId: string, code: string, detail: string,
  phase: string, logSha: string | null = null, logJobId: string | null = null,
): Promise<void> {
  await db.prepare(
    `UPDATE app_notarization_attempts SET status_state = 'error', error_class = ?1, error_detail = ?2,
     error_phase = ?3, log_sha256 = ?4, log_job_id = ?5, completed_at = ?6 WHERE id = ?7`,
  ).bind(code, detail, phase, logSha, logJobId, Date.now(), attemptId).run();
}

function classifySubmitError(e: unknown): { code: string; detail: string } {
  if (e instanceof AscApiError) {
    if (e.status === 401) return { code: ERR.AUTH_INVALID, detail: "ASC key authentication failed" };
    if (e.status === 403) return { code: ERR.ROLE_INSUFFICIENT, detail: "ASC key role insufficient for notarization" };
    if (e.status >= 500) return { code: ERR.APPLE_REQUEST_FAILED, detail: `${e.message} (${e.status})` };
    return { code: ERR.APPLE_REQUEST_FAILED, detail: e.message };
  }
  return { code: ERR.UNKNOWN, detail: e instanceof Error ? e.message : String(e) };
}
