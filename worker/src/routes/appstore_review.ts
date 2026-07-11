/**
 * App Store review status (read-only).
 *
 * GET /api/apps/:appId/appstore-review
 *   Surfaces the App Store review state of this iOS app's recent versions and
 *   the TestFlight beta-review state of its recent builds, straight from App
 *   Store Connect. Read-only — it never touches the release/publish flow.
 *
 *   Reuses the TestFlight ASC integration end-to-end: same encrypted
 *   credentials, same bundle-id → ASC app resolution. iOS-only; other
 *   platforms get { applicable: false } so the admin can skip the panel.
 *
 *   Apple hiccups never 500 this endpoint — they come back as
 *   { configured: true, error } with a 200 so the panel can show the message.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import {
  getAppStoreVersions,
  getBetaReviewStates,
  resolveAscAppId,
} from "../lib/asc_api";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

export async function handleAppStoreReview(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "server is missing ASC_CRED_ENC_KEY" }, 500);

  const app = await c.env.DB.prepare(
    "SELECT platform FROM apps WHERE id = ?1",
  )
    .bind(appId)
    .first<{ platform: string }>();
  if (!app) return c.json({ error: "app not found" }, 404);

  // The App Store review panel only applies to iOS apps.
  if (app.platform !== "ios") {
    return c.json({ platform: app.platform, applicable: false });
  }

  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ configured: false });

  // Resolve the iOS bundle id from this app's channels. Prefer the "main"
  // channel; otherwise take the earliest-created channel that carries one.
  const bundleRow = await c.env.DB.prepare(
    `SELECT bundle_id FROM channels
     WHERE app_id = ?1 AND bundle_id IS NOT NULL AND bundle_id != ''
     ORDER BY CASE WHEN slug = 'main' THEN 0 ELSE 1 END, created_at ASC
     LIMIT 1`,
  )
    .bind(appId)
    .first<{ bundle_id: string }>();
  const bundleId = bundleRow?.bundle_id ?? null;
  if (!bundleId) {
    return c.json({
      configured: true,
      bundle_id: null,
      error: "no iOS bundle id on any channel",
    });
  }

  try {
    const ascAppId = await resolveAscAppId(creds, bundleId);
    if (!ascAppId) {
      return c.json({
        configured: true,
        bundle_id: bundleId,
        error: `no App Store Connect app record for bundle id ${bundleId}`,
      });
    }
    const [appStoreVersions, testflightBuilds] = await Promise.all([
      getAppStoreVersions(creds, ascAppId),
      getBetaReviewStates(creds, ascAppId),
    ]);
    return c.json({
      configured: true,
      applicable: true,
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      app_store_versions: appStoreVersions,
      testflight_builds: testflightBuilds,
    });
  } catch (e) {
    return c.json({
      configured: true,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
