/**
 * Apple Notary API client — JWT auth + submission lifecycle.
 *
 * Mirrors the ASC API client (asc_api.ts) but targets the Notary REST API
 * (appstoreconnect.apple.com/notary/v2). Auth is identical: the SAME App
 * Store Connect API key (ES256 JWT) that TestFlight uses authenticates
 * notary submissions — confirmed by Apple's own documentation:
 *
 *   "Use the same key to sign tokens for the notary service that you use
 *    for the App Store Connect API."
 *   — Submitting software for notarization over the web
 *
 * Flow: POST /submissions (sha256 + name) → Apple returns temp S3 creds →
 * stream artifact from R2 to S3 → poll GET /submissions/{id} for terminal
 * state → GET /submissions/{id}/logs for binding verification.
 *
 * The .p8 private key is NEVER returned to the caller. It is decrypted
 * in-worker (getAscCredentials), used to sign the JWT, and discarded.
 * Apple's temporary S3 credentials are used in-worker to stream R2→S3 and
 * then discarded — never persisted, never returned.
 */

import type { AscApiCredentials } from "./asc_api";
import { createAscJwt, AscApiError } from "./asc_api";

/** Notary API uses a different host than the ASC API (no /v1 prefix). */
export const NOTARY_API_BASE = "https://appstoreconnect.apple.com/notary/v2";

// ---------- Authenticated request (reuses ASC JWT) ----------

/**
 * Authenticated JSON request against the Notary API. Throws AscApiError
 * (same error class as asc_api.ts for consistent handling).
 *
 * If the ASC key's role does not permit notarization, Apple returns 401/403.
 * Callers MUST classify this as NOTARY_ROLE_INSUFFICIENT for operator
 * remediation (per Phase 0 path 4 decision — Quinn, 2026-07-18).
 */
export async function notaryRequest<T>(
  creds: AscApiCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const jwt = await createAscJwt(creds);
  const res = await fetch(`${NOTARY_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body; keep raw text for error detail
  }
  if (!res.ok) {
    const errors = (
      parsed as { errors?: Array<{ title?: string; detail?: string }> } | undefined
    )?.errors;
    const first = errors?.[0];
    throw new AscApiError(
      res.status,
      first?.title ??
        `Notary API ${method} ${path} failed (${res.status})`,
      first?.detail ?? (parsed ? null : text.slice(0, 500) || null),
    );
  }
  return parsed as T;
}

// ---------- Submission resources ----------

export interface NotarySubmissionRequest {
  /** File name for Apple's records (unique per submission recommended). */
  submissionName: string;
  /** SHA-256 of the artifact bytes being submitted (hex). */
  sha256: string;
  /** Optional webhook callback when notarization completes. */
  notifications?: Array<{ channel: string; target: string }>;
}

export interface NotarySubmissionResponse {
  data: {
    id: string;
    type: "submissionsPostResponse";
    attributes: {
      /** Temporary AWS credentials for S3 upload (expire in 12 hours). */
      awsAccessKeyId: string;
      awsSecretAccessKey: string;
      awsSessionToken: string;
      bucket: string;
      object: string;
    };
  };
  meta: Record<string, unknown>;
}

export type NotarySubmissionState =
  | "InProgress"
  | "Accepted"
  | "Invalid"
  | "Rejected";

export interface NotarySubmissionStatus {
  data: {
    id: string;
    type: "submissions";
    attributes: {
      submissionName: string | null;
      status: NotarySubmissionState | null;
      createdDate: string | null;
      finishedDate: string | null;
    };
  };
}

export interface NotarySubmissionLogResponse {
  data: {
    id: string;
    type: "submissions";
    attributes: {
      /** URL to download the JSON log file (valid for a few hours). */
      devId: string;
      logUrl: string;
    };
  };
}

/**
 * The fetched log JSON. Contains the SHA-256 of the submitted artifact,
 * which MUST match the source artifact SHA for the binding invariant
 * (ready_for_staple = true only when log SHA == source SHA).
 */
export interface NotaryLogJson {
  /** Archive hash in the notarization log — the binding source. */
  archiveHash?: string;
  /** Apple may report issues/warnings even on Accepted submissions. */
  issues?: Array<{ severity: string; message: string }>;
  [key: string]: unknown;
}

// ---------- API operations ----------

/**
 * Start a notary submission. Does NOT upload the artifact — returns temp S3
 * credentials that the caller uses to PUT the artifact to Apple's S3.
 */
export async function createNotarySubmission(
  creds: AscApiCredentials,
  req: NotarySubmissionRequest,
): Promise<NotarySubmissionResponse> {
  return notaryRequest<NotarySubmissionResponse>(creds, "POST", "/submissions", req);
}

/**
 * Poll a notary submission's status. Poll until terminal
 * (Accepted / Invalid / Rejected).
 */
export async function getNotarySubmissionStatus(
  creds: AscApiCredentials,
  submissionId: string,
): Promise<NotarySubmissionStatus> {
  // Validate submissionId is a UUID before placing it in the path
  // (avoids leading-dash / path-injection issues — #294 seq 27).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submissionId)) {
    throw new AscApiError(400, "invalid submission id", "submission id must be a UUID");
  }
  return notaryRequest<NotarySubmissionStatus>(
    creds,
    "GET",
    `/submissions/${submissionId}`,
  );
}

/**
 * Get the log URL for a terminal submission, then fetch and parse the log JSON.
 * The log contains the artifact's SHA (archiveHash) used for binding verification.
 */
export async function getNotarySubmissionLog(
  creds: AscApiCredentials,
  submissionId: string,
): Promise<{ logUrl: string; log: NotaryLogJson }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submissionId)) {
    throw new AscApiError(400, "invalid submission id", "submission id must be a UUID");
  }
  const logResp = await notaryRequest<NotarySubmissionLogResponse>(
    creds,
    "GET",
    `/submissions/${submissionId}/logs`,
  );
  const logUrl = logResp.data.attributes.logUrl;
  const logResp2 = await fetch(logUrl);
  if (!logResp2.ok) {
    throw new AscApiError(
      logResp2.status,
      `failed to fetch notary log from Apple (${logResp2.status})`,
    );
  }
  const log = (await logResp2.json()) as NotaryLogJson;
  return { logUrl, log };
}

/**
 * Upload an artifact to Apple's S3 using the temporary credentials from
 * createNotarySubmission. The artifact is streamed from an R2 object body
 * (ReadableStream) directly to S3 — never buffered in memory.
 *
 * Uses a single PUT (Notary API uses simple S3 PUT, not multipart).
 */
export async function uploadArtifactToS3(
  attrs: NotarySubmissionResponse["data"]["attributes"],
  body: ReadableStream,
  contentType = "application/octet-stream",
): Promise<void> {
  // Apple's Notary API provides temp AWS creds for a direct S3 PUT.
  // We use a presigned-style URL approach: the bucket+object+creds from
  // the submission response, with a standard S3 PUT.
  const url = `https://${attrs.bucket}.s3-accelerate.amazonaws.com/${attrs.object}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": contentType,
      "x-amz-security-token": attrs.awsSessionToken,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AscApiError(
      res.status,
      `S3 artifact upload failed (${res.status})`,
      text.slice(0, 500) || null,
    );
  }
}
