/**
 * Notarization lane (broker-only, platform feature).
 *
 * POST /api/apps/:appId/builds/:buildId/notarize
 *   Starts Apple notarization of an existing signed build asset. Streams
 *   the asset from R2 to Apple's S3 (using temp creds from the Notary API),
 *   records the submission, and returns the initial state. The .p8 key
 *   is decrypted in-worker and NEVER returned to the caller.
 *
 * GET /api/apps/:appId/notarizations/:submissionId
 *   Polls Apple for the notarization status. On a terminal state, fetches
 *   the Apple log and verifies the artifact SHA binding before reporting
 *   ready_for_staple.
 *
 * Architecture: mirrors worker/src/routes/testflight.ts. Same credential
 * row (app_asc_credentials), same ASC JWT, same R2→Apple streaming pattern.
 * Staple/validate stay caller-side (no Apple key needed).
 *
 * RBAC: POST = publisher, GET = viewer (per Quinn 2026-07-18; NOT mirroring
 * TestFlight's legacy admin).
 *
 * Idempotency: three-state by source SHA (per Quinn 2026-07-18):
 *   InProgress  → dedupe into existing submission
 *   Accepted    → return existing result (idempotent success)
 *   Invalid/err → allow new submission
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { currentActor } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import { AscApiError } from "../lib/asc_api";
import {
  AscApiCredentials,
} from "../lib/asc_api";
import {
  createNotarySubmission,
  getNotarySubmissionStatus,
  getNotarySubmissionLog,
  uploadArtifactToS3,
  type NotarySubmissionState,
} from "../lib/notary_api";
import { createOperation, updateOperation } from "./operations";
import { insertAuditLog } from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

/** Artifact filetypes Apple's Notary API accepts (bare .app rejected — must zip). */
const NOTARY_FILETYPE_WHITELIST = new Set(["dmg", "zip", "pkg"]);

/** Content-Type mapping for S3 upload. */
const FILETYPE_CONTENT_TYPE: Record<string, string> = {
  dmg: "application/x-apple-diskimage",
  zip: "application/zip",
  pkg: "application/octet-stream",
};

/**
 * Stable error codes for operator-facing diagnostics.
 * NOTARY_ROLE_INSUFFICIENT is the Phase 0 path-4 probe replacement:
 * the first real call against a key with insufficient role produces this
 * clear, actionable error instead of a generic failure.
 */
const ERR = {
  NO_ASC_CREDS: "NO_ASC_CREDENTIALS",
  NO_ENC_KEY: "MISSING_ASC_CRED_ENC_KEY",
  BUILD_NOT_FOUND: "BUILD_NOT_FOUND",
  NO_NOTARY_ASSET: "NO_NOTARIZABLE_ASSET",
  UNSUPPORTED_FILETYPE: "UNSUPPORTED_FILETYPE",
  ROLE_INSUFFICIENT: "NOTARY_ROLE_INSUFFICIENT",
  APPLE_REQUEST_FAILED: "APPLE_REQUEST_FAILED",
  S3_UPLOAD_FAILED: "S3_UPLOAD_FAILED",
  SHA_MISMATCH: "SHA_BINDING_MISMATCH",
} as const;

/** Check if an Apple API error is a role/auth problem (401/403). */
function isRoleError(e: unknown): boolean {
  return e instanceof AscApiError && (e.status === 401 || e.status === 403);
}

// ──────────── POST /notarize ────────────

export async function handleNotarize(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildIdParam = c.req.param("buildId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) {
    return c.json({ error: "server is missing ASC_CRED_ENC_KEY", code: ERR.NO_ENC_KEY }, 500);
  }

  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) {
    return c.json(
      {
        error: "no ASC credentials configured — add them in Settings first",
        code: ERR.NO_ASC_CREDS,
      },
      400,
    );
  }

  // Resolve build (short-id tolerant, same as testflight).
  const build = await c.env.DB.prepare(
    `SELECT id, version_name FROM builds
     WHERE app_id = ?1 AND id LIKE ?2 || '%' LIMIT 2`,
  )
    .bind(appId, buildIdParam)
    .all<{ id: string; version_name: string }>();
  if (!build.results || build.results.length !== 1) {
    return c.json({ error: "build not found (or ambiguous short id)", code: ERR.BUILD_NOT_FOUND }, 404);
  }
  const b = build.results[0]!;

  // Resolve a notarizable asset (DMG preferred, then zip/pkg).
  // Caller can hint filetype via body; otherwise pick DMG > ZIP > PKG.
  const body = (await c.req.json().catch(() => ({}))) as { filetype?: unknown };
  const hintFiletype = typeof body.filetype === "string" ? body.filetype.toLowerCase() : "";

  const asset = await resolveNotaryAsset(c.env.DB, b.id, hintFiletype);
  if (!asset) {
    return c.json(
      {
        error: `build has no notarizable asset (accepted filetypes: ${[...NOTARY_FILETYPE_WHITELIST].join(", ")})`,
        code: ERR.NO_NOTARY_ASSET,
      },
      404,
    );
  }

  // Idempotency check: is there already a non-terminal notarization for this (app, SHA)?
  const existing = await c.env.DB.prepare(
    `SELECT * FROM app_notarizations
     WHERE app_id = ?1 AND source_sha256 = ?2
       AND state IN ('pending', 'submitting', 'in_progress', 'accepted')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(appId, asset.file_hash)
    .first<AppNotarizationRow>();

  if (existing) {
    // Accepted → return existing result (idempotent success, no new Apple submission).
    // InProgress/submitting → dedupe into the existing submission.
    return c.json({
      operation_id: existing.operation_id,
      notarization_id: existing.id,
      submission_id: existing.apple_submission_id,
      state: existing.state,
      ready_for_staple: existing.ready_for_staple === 1,
      idempotent: true,
    });
  }

  // Create operation + audit before any Apple call.
  const op = await createOperation(c.env.DB, {
    app_id: appId,
    kind: "notarize" as any, // operation_logs.kind will need 'notarize' added
    actor: currentActor(c),
    input: JSON.stringify({
      build_id: b.id,
      version_name: b.version_name,
      asset_id: asset.id,
      filetype: asset.filetype,
      size_bytes: asset.size_bytes,
      sha256: asset.file_hash,
    }),
  });
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "notarize.start",
    payload: { build_id: b.id, asset_id: asset.id, sha256: asset.file_hash },
  });

  // Insert ledger row (the partial unique index enforces idempotency at the DB level too).
  const notarizationId = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO app_notarizations
       (id, app_id, build_id, build_asset_id, source_sha256, source_size_bytes,
        source_filetype, state, ready_for_staple, operation_id,
        created_by_actor, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'submitting', 0, ?8, ?9, ?10, ?10)`,
  )
    .bind(
      notarizationId, appId, b.id, asset.id,
      asset.file_hash, asset.size_bytes, asset.filetype,
      op.id, currentActor(c), now,
    )
    .run();

  // Submit to Apple + upload artifact.
  try {
    const submissionName = `${b.version_name}-${asset.filetype}-${asset.file_hash.slice(0, 12)}.${asset.filetype}`;
    const submissionResp = await createNotarySubmission(creds, {
      submissionName,
      sha256: asset.file_hash,
    });
    const appleSubmissionId = submissionResp.data.id;

    // Record the Apple submission id.
    await c.env.DB.prepare(
      `UPDATE app_notarizations SET apple_submission_id = ?1, state = 'submitting', updated_at = ?2 WHERE id = ?3`,
    )
      .bind(appleSubmissionId, Date.now(), notarizationId)
      .run();

    await updateOperation(c.env.DB, op.id, {
      status: "in_progress",
      progress: 20,
      output: JSON.stringify({ apple_submission_id: appleSubmissionId }),
    });

    // Stream R2 → Apple S3.
    const r2Object = await c.env.APK_BUCKET.get(asset.r2_key);
    if (!r2Object) {
      throw new Error(`asset object missing from R2 (${asset.r2_key})`);
    }
    await uploadArtifactToS3(
      submissionResp.data.attributes,
      r2Object.body,
      FILETYPE_CONTENT_TYPE[asset.filetype] ?? "application/octet-stream",
    );

    await updateOperation(c.env.DB, op.id, { progress: 50, output: JSON.stringify({ apple_submission_id: appleSubmissionId, uploaded: true }) });

    // First status read.
    const status = await getNotarySubmissionStatus(creds, appleSubmissionId);
    const state = mapAppleState(status.data.attributes.status);
    await updateNotarizationState(c.env.DB, notarizationId, state);
    await updateOperation(c.env.DB, op.id, {
      status: state === "accepted" || state === "invalid" || state === "rejected" ? "success" : "in_progress",
      progress: 90,
      completed_at: state === "accepted" || state === "invalid" || state === "rejected" ? Date.now() : undefined,
    });

    return c.json({
      operation_id: op.id,
      notarization_id: notarizationId,
      submission_id: appleSubmissionId,
      state,
      ready_for_staple: false, // only true after log SHA binding check (GET status)
    });
  } catch (e) {
    const { code, detail, status: httpStatus } = classifyError(e);
    await updateNotarizationState(c.env.DB, notarizationId, "error", code, detail);
    await updateOperation(c.env.DB, op.id, {
      status: "failed",
      error: JSON.stringify({ code, detail }),
      completed_at: Date.now(),
    });
    return c.json(
      { operation_id: op.id, notarization_id: notarizationId, ok: false, code, detail },
      httpStatus,
    );
  }
}

// ──────────── GET /notarizations/:submissionId ────────────

export async function handleNotarizationStatus(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const submissionIdParam = c.req.param("submissionId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "server is missing ASC_CRED_ENC_KEY", code: ERR.NO_ENC_KEY }, 500);
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ error: "no ASC credentials configured", code: ERR.NO_ASC_CREDS }, 400);

  // Look up by notarization id (our ledger id) or Apple submission id.
  const row = await c.env.DB.prepare(
    `SELECT * FROM app_notarizations
     WHERE app_id = ?1 AND (id = ?2 OR apple_submission_id = ?2)
     LIMIT 1`,
  )
    .bind(appId, submissionIdParam)
    .first<AppNotarizationRow>();
  if (!row) return c.json({ error: "notarization not found" }, 404);

  // Already terminal + binding-verified → return cached result.
  if (row.state === "accepted" && row.ready_for_staple === 1) {
    return c.json({
      notarization_id: row.id,
      submission_id: row.apple_submission_id,
      state: row.state,
      ready_for_staple: true,
      log_sha256: row.apple_log_sha256,
      source_sha256: row.source_sha256,
    });
  }

  // Poll Apple.
  try {
    if (!row.apple_submission_id) {
      return c.json({ error: "submission not yet sent to Apple", state: row.state }, 200);
    }
    const status = await getNotarySubmissionStatus(creds, row.apple_submission_id);
    const appleState = status.data.attributes.status;
    const state = mapAppleState(appleState);

    // If terminal, fetch log and verify SHA binding.
    let logSha256: string | null = null;
    let readyForStaple = false;
    if (state === "accepted") {
      const { log } = await getNotarySubmissionLog(creds, row.apple_submission_id);
      logSha256 = log.archiveHash ?? null;
      // Binding invariant: Apple's log SHA MUST match the source artifact SHA.
      readyForStaple = logSha256 === row.source_sha256;
      if (!readyForStaple) {
        // SHA mismatch — do NOT report ready_for_staple. Record the mismatch.
        await updateNotarizationState(
          c.env.DB, row.id, "error",
          ERR.SHA_MISMATCH,
          `Apple log SHA ${logSha256} != source SHA ${row.source_sha256}`,
        );
        return c.json({
          notarization_id: row.id,
          submission_id: row.apple_submission_id,
          state: "error",
          code: ERR.SHA_MISMATCH,
          detail: "Apple log SHA does not match source artifact SHA",
          log_sha256: logSha256,
          source_sha256: row.source_sha256,
        }, 500);
      }
    }

    await updateNotarizationState(c.env.DB, row.id, state, undefined, undefined, logSha256, readyForStaple);

    return c.json({
      notarization_id: row.id,
      submission_id: row.apple_submission_id,
      state,
      ready_for_staple: readyForStaple,
      log_sha256: logSha256,
      source_sha256: row.source_sha256,
    });
  } catch (e) {
    if (isRoleError(e)) {
      return c.json(
        { error: "ASC key role insufficient for notarization API", code: ERR.ROLE_INSUFFICIENT },
        502,
      );
    }
    const detail = e instanceof AscApiError ? { status: e.status, detail: e.detail } : { error: String(e) };
    return c.json({ error: "Apple API request failed", code: ERR.APPLE_REQUEST_FAILED, ...detail }, 502);
  }
}

// ──────────── Helpers ────────────

interface NotaryAssetRow {
  id: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  filetype: string;
}

async function resolveNotaryAsset(
  db: D1Database,
  buildId: string,
  hintFiletype: string,
): Promise<NotaryAssetRow | null> {
  const order = hintFiletype && NOTARY_FILETYPE_WHITELIST.has(hintFiletype)
    ? [hintFiletype, ...[...NOTARY_FILETYPE_WHITELIST].filter((f) => f !== hintFiletype)]
    : ["dmg", "zip", "pkg"];
  for (const ft of order) {
    const row = await db
      .prepare(
        `SELECT id, r2_key, file_hash, size_bytes, filetype FROM build_assets
         WHERE build_id = ?1 AND filetype = ?2 AND artifact_kind = 'installable'
         LIMIT 1`,
      )
      .bind(buildId, ft)
      .first<NotaryAssetRow>();
    if (row) return row;
  }
  return null;
}

interface AppNotarizationRow {
  id: string;
  app_id: string;
  build_id: string;
  build_asset_id: string;
  apple_submission_id: string | null;
  source_sha256: string;
  source_size_bytes: number;
  source_filetype: string;
  state: string;
  apple_log_sha256: string | null;
  ready_for_staple: number;
  operation_id: string;
  error_code: string | null;
  error_detail: string | null;
  created_by_actor: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function mapAppleState(appleState: NotarySubmissionState | null): string {
  switch (appleState) {
    case "Accepted": return "accepted";
    case "Invalid": return "invalid";
    case "Rejected": return "rejected";
    case "InProgress": return "in_progress";
    default: return "in_progress"; // null or unknown → still processing
  }
}

async function updateNotarizationState(
  db: D1Database,
  id: string,
  state: string,
  errorCode?: string,
  errorDetail?: string,
  logSha256?: string | null,
  readyForStaple?: boolean,
): Promise<void> {
  const now = Date.now();
  const sets = ["state = ?", "updated_at = ?"];
  const binds: any[] = [state, now];
  if (errorCode !== undefined) { sets.push("error_code = ?"); binds.push(errorCode); }
  if (errorDetail !== undefined) { sets.push("error_detail = ?"); binds.push(errorDetail); }
  if (logSha256 !== undefined) { sets.push("apple_log_sha256 = ?"); binds.push(logSha256); }
  if (readyForStaple !== undefined) { sets.push("ready_for_staple = ?"); binds.push(readyForStaple ? 1 : 0); }
  if (state === "accepted" || state === "invalid" || state === "rejected" || state === "error") {
    sets.push("completed_at = ?"); binds.push(now);
  }
  binds.push(id);
  await db.prepare(`UPDATE app_notarizations SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
}

function classifyError(e: unknown): { code: string; detail: string; status: number } {
  if (isRoleError(e)) {
    return {
      code: ERR.ROLE_INSUFFICIENT,
      detail: "ASC key role does not permit notarization. Upgrade the key role in App Store Connect or rotate the key in Settings.",
      status: 502,
    };
  }
  if (e instanceof AscApiError) {
    return {
      code: e.status >= 500 ? ERR.APPLE_REQUEST_FAILED : ERR.APPLE_REQUEST_FAILED,
      detail: `${e.message}${e.detail ? ` — ${e.detail}` : ""}`,
      status: 502,
    };
  }
  return { code: ERR.APPLE_REQUEST_FAILED, detail: e instanceof Error ? e.message : String(e), status: 500 };
}
