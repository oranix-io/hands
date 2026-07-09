import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { insertAuditLog } from "../lib/permissions";
import {
  storeAscCredentials,
  getAscCredentialsMeta,
  deleteAscCredentials,
} from "../lib/asc_credentials";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

/** GET — returns credential metadata only (never the .p8). */
export async function handleGetAscCredentials(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const meta = await getAscCredentialsMeta(c.env.DB, appId);
  return c.json({ asc_credentials: meta });
}

/**
 * PUT — set (or rotate) the app's ASC API credentials. Body:
 * { key_id, issuer_id, p8 }. The .p8 is the raw PEM contents of the
 * downloaded AuthKey_XXXX.p8. Stored encrypted; response is metadata only.
 */
export async function handleSetAscCredentials(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) {
    return c.json(
      { error: "server is missing ASC_CRED_ENC_KEY; cannot store credentials" },
      500,
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    key_id?: unknown;
    issuer_id?: unknown;
    p8?: unknown;
  };
  const key_id = typeof body.key_id === "string" ? body.key_id.trim() : "";
  const issuer_id =
    typeof body.issuer_id === "string" ? body.issuer_id.trim() : "";
  const p8 = typeof body.p8 === "string" ? body.p8.trim() : "";
  if (!key_id) return c.json({ error: "key_id is required" }, 400);
  if (!issuer_id) return c.json({ error: "issuer_id is required" }, 400);
  if (!p8) return c.json({ error: "p8 is required" }, 400);
  if (!p8.includes("BEGIN PRIVATE KEY")) {
    return c.json(
      { error: "p8 must be the PEM contents of the AuthKey_XXXX.p8 file" },
      400,
    );
  }

  const actor = currentActor(c);
  const meta = await storeAscCredentials(c.env.DB, encKey, {
    app_id: appId,
    key_id,
    issuer_id,
    p8,
    actor,
  });

  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "asc_credentials.set",
    // never log the p8 or its ciphertext
    payload: { key_id, issuer_id },
    created_at: meta.updated_at,
  });

  return c.json({ asc_credentials: meta });
}

export async function handleDeleteAscCredentials(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  await deleteAscCredentials(c.env.DB, appId);
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "asc_credentials.delete",
    payload: {},
  });
  return c.json({ ok: true });
}
