import type { Context } from "hono";
import { currentActor } from "../middleware/auth";
import {
  createBuild,
  createBuildAsset,
  resolveChannelId,
  type BuildAssetInput,
} from "./builds";
import { createRelease, getReleaseForApp } from "./releases";

interface LegacyVersionPayload {
  channel: string;
  version_name: string;
  version_code: number;
  package_name: string;
  signature_sha256: string;
  min_sdk?: number;
  target_sdk?: number;
  size_bytes: number;
  file_hash: string;
  r2_key: string;
  changelog?: string;
  should_force_update?: boolean;
  availability_at?: number;
  provenance?: Record<string, unknown>;
  provenance_json?: string | Record<string, unknown>;
}

interface LegacyVersionRow {
  id: string;
  app_id: string;
  channel: string;
  version_name: string;
  version_code: number;
  package_name: string;
  signature_sha256: string;
  min_sdk: number | null;
  target_sdk: number | null;
  size_bytes: number;
  file_hash: string;
  r2_key: string;
  enabled: number;
  changelog: string | null;
  should_force_update: number;
  availability_at: number | null;
  provenance_json: string;
  created_at: number;
  build_id?: string;
  release_status?: string;
}

function parsedMetadataFromLegacy(body: LegacyVersionPayload) {
  return {
    package_name: body.package_name,
    signature_sha256: body.signature_sha256,
    min_sdk: body.min_sdk ?? null,
    target_sdk: body.target_sdk ?? null,
    app_label: null,
    size_bytes: body.size_bytes,
    native_codes: [],
  };
}

function provenanceJson(body: LegacyVersionPayload): string | Record<string, unknown> {
  return body.provenance_json ?? body.provenance ?? {};
}

function legacyVersionSelect(where: string) {
  return `
    WITH release_versions AS (
      SELECT r.id AS id, r.app_id AS app_id, c.slug AS channel,
             b.version_name AS version_name, b.version_code AS version_code,
             COALESCE(json_extract(b.parsed_metadata_json, '$.package_name'), '') AS package_name,
             COALESCE(json_extract(b.parsed_metadata_json, '$.signature_sha256'), ba.signature, '') AS signature_sha256,
             CAST(json_extract(b.parsed_metadata_json, '$.min_sdk') AS INTEGER) AS min_sdk,
             CAST(json_extract(b.parsed_metadata_json, '$.target_sdk') AS INTEGER) AS target_sdk,
             COALESCE(CAST(json_extract(b.parsed_metadata_json, '$.size_bytes') AS INTEGER), ba.size_bytes, 0) AS size_bytes,
             COALESCE(ba.file_hash, '') AS file_hash,
             COALESCE(ba.r2_key, '') AS r2_key,
             CASE WHEN r.status = 'active' THEN 1 ELSE 0 END AS enabled,
             COALESCE(r.changelog, b.changelog) AS changelog,
             r.should_force_update AS should_force_update,
             COALESCE(r.availability_at, b.availability_at) AS availability_at,
             r.provenance_json AS provenance_json,
             r.created_at AS created_at,
             b.id AS build_id,
             r.status AS release_status
      FROM releases r
      JOIN builds b ON b.id = r.build_id
      LEFT JOIN channels c ON c.id = r.channel_id
      LEFT JOIN build_assets ba ON ba.id = (
        SELECT id FROM build_assets
        WHERE build_id = b.id
        ORDER BY created_at ASC
        LIMIT 1
      )
    ),
    legacy_versions AS (
      SELECT v.id AS id, v.app_id AS app_id, v.channel AS channel,
             v.version_name AS version_name, v.version_code AS version_code,
             v.package_name AS package_name, v.signature_sha256 AS signature_sha256,
             v.min_sdk AS min_sdk, v.target_sdk AS target_sdk,
             v.size_bytes AS size_bytes, v.file_hash AS file_hash, v.r2_key AS r2_key,
             v.enabled AS enabled, v.changelog AS changelog,
             v.should_force_update AS should_force_update,
             v.availability_at AS availability_at,
             v.provenance_json AS provenance_json,
             v.created_at AS created_at,
             v.id AS build_id,
             CASE WHEN v.enabled = 1 THEN 'active' ELSE 'disabled' END AS release_status
      FROM versions v
      WHERE NOT EXISTS (SELECT 1 FROM builds b WHERE b.id = v.id)
    )
    SELECT *
    FROM (
      SELECT * FROM release_versions
      UNION ALL
      SELECT * FROM legacy_versions
    ) AS version_union
    ${where}
  `;
}

async function findLegacyVersion(
  db: D1Database,
  appId: string,
  versionId: string,
): Promise<LegacyVersionRow | null> {
  return await db
    .prepare(
      `${legacyVersionSelect("WHERE app_id = ?1 AND id = ?2")}
       LIMIT 1`,
    )
    .bind(appId, versionId)
    .first<LegacyVersionRow>();
}

export async function handleListVersions(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const channel = c.req.query("channel");
  const enabled = c.req.query("enabled");

  const conditions = ["app_id = ?1"];
  const binds: (string | number)[] = [appId];
  if (channel) {
    conditions.push(`channel = ?${binds.length + 1}`);
    binds.push(channel);
  }
  if (enabled !== undefined) {
    conditions.push(`enabled = ?${binds.length + 1}`);
    binds.push(enabled === "true" ? 1 : 0);
  }

  const { results } = await c.env.DB.prepare(
    `${legacyVersionSelect(`WHERE ${conditions.join(" AND ")}`)}
     ORDER BY created_at DESC
     LIMIT 100`,
  )
    .bind(...binds)
    .all<LegacyVersionRow>();

  return c.json({ versions: results });
}

export async function handleGetVersion(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  const row = await findLegacyVersion(c.env.DB, appId, versionId);
  if (!row) return c.json({ error: "not found" }, 404);

  const ttl = Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
  const downloadUrl = await generateSignedR2Url(c.env, row.r2_key, ttl);
  return c.json({ ...row, download_url: downloadUrl });
}

export async function handleCreateVersion(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json()) as LegacyVersionPayload;
  if (!body.r2_key) {
    return c.json(
      { error: "r2_key required (upload APK first via /api/apps/:appId/upload)" },
      400,
    );
  }

  const actor = currentActor(c);
  const op = await createPublishOperation(c.env.DB, appId, actor, body);
  try {
    const releaseId = await insertVersion(c.env.DB, appId, body, undefined, actor);
    const row = await findLegacyVersion(c.env.DB, appId, releaseId);
    await completePublishOperation(c.env.DB, op.id, releaseId);
    return c.json(row ?? { id: releaseId, app_id: appId, ...body }, 201);
  } catch (e) {
    await failPublishOperation(c.env.DB, op.id, (e as Error).message);
    throw e;
  }
}

export async function insertVersion(
  db: D1Database,
  appId: string,
  body: LegacyVersionPayload,
  id: string = crypto.randomUUID(),
  actor = "system",
): Promise<string> {
  if (!body.channel) throw new Error("channel required");
  if (!body.r2_key) throw new Error("r2_key required");
  const channelId = await resolveChannelId(db, appId, body.channel);
  if (!channelId) throw new Error(`channel '${body.channel}' not found`);

  const buildId = id;
  await createBuild(
    db,
    appId,
    {
      channel_id: channelId,
      product_type: "android-apk",
      release_type: "stable",
      version_name: body.version_name,
      version_code: body.version_code,
      changelog: body.changelog ?? null,
      source: "web",
      status: "succeeded",
      build_metadata_json: {},
      parsed_metadata_json: parsedMetadataFromLegacy(body),
      should_force_update: body.should_force_update ?? false,
      availability_at: body.availability_at ?? null,
      provenance_json: provenanceJson(body),
    },
    actor,
    buildId,
  );

  const asset: BuildAssetInput = {
    platform: "android",
    arch: null,
    variant: null,
    filetype: "apk",
    r2_key: body.r2_key,
    file_hash: body.file_hash,
    size_bytes: body.size_bytes,
    signature: body.signature_sha256,
    metadata_json: {
      package_name: body.package_name,
      min_sdk: body.min_sdk ?? null,
      target_sdk: body.target_sdk ?? null,
    },
  };
  await createBuildAsset(db, appId, buildId, asset, actor);

  return await createRelease(
    db,
    appId,
    {
      build_id: buildId,
      channel_id: channelId,
      product_type: "android-apk",
      release_type: "stable",
      changelog: body.changelog ?? null,
      should_force_update: body.should_force_update ?? false,
      availability_at: body.availability_at ?? null,
      provenance_json: provenanceJson(body),
      scopes: [{ scope_type: "full", scope_value: "all" }],
    },
    actor,
  );
}

export async function handleUpdateVersion(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  const body = (await c.req.json()) as {
    enabled?: boolean;
    channel?: string;
    should_force_update?: boolean;
  };
  const existing = await findLegacyVersion(c.env.DB, appId, versionId);
  if (!existing) return c.json({ error: "not found" }, 404);

  const release = await getReleaseForApp(c.env.DB, appId, versionId);
  if (!release) {
    await updateLegacyVersionRow(c.env.DB, appId, versionId, body);
  } else {
    const updates: string[] = [];
    const binds: (string | number | null)[] = [];
    if (body.enabled !== undefined) {
      updates.push(`status = ?${binds.length + 1}`);
      binds.push(body.enabled ? "active" : "cancelled");
    }
    if (body.channel !== undefined) {
      const channelId = await resolveChannelId(c.env.DB, appId, body.channel);
      if (!channelId) return c.json({ error: `channel '${body.channel}' not found` }, 400);
      updates.push(`channel_id = ?${binds.length + 1}`);
      binds.push(channelId);
    }
    if (body.should_force_update !== undefined) {
      updates.push(`should_force_update = ?${binds.length + 1}`);
      binds.push(body.should_force_update ? 1 : 0);
    }
    if (updates.length === 0) return c.json({ error: "nothing to update" }, 400);
    updates.push(`updated_at = ?${binds.length + 1}`);
    binds.push(Date.now());
    binds.push(versionId, appId);
    await c.env.DB.prepare(
      `UPDATE releases SET ${updates.join(", ")} WHERE id = ?${binds.length - 1} AND app_id = ?${binds.length}`,
    )
      .bind(...binds)
      .run();
  }

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      "version.update",
      currentActor(c),
      JSON.stringify({ versionId, ...body }),
      Date.now(),
    )
    .run();

  return c.json({ ok: true });
}

export async function handleDeleteVersion(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const versionId = c.req.param("versionId") ?? "";
  const release = await getReleaseForApp(c.env.DB, appId, versionId);
  if (release) {
    await c.env.DB.prepare("DELETE FROM release_scopes WHERE release_id = ?1")
      .bind(versionId)
      .run();
    await c.env.DB.prepare("DELETE FROM releases WHERE id = ?1 AND app_id = ?2")
      .bind(versionId, appId)
      .run();
  } else {
    await c.env.DB.prepare("DELETE FROM versions WHERE id = ?1 AND app_id = ?2")
      .bind(versionId, appId)
      .run();
  }
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      "version.delete",
      currentActor(c),
      JSON.stringify({ versionId }),
      Date.now(),
    )
    .run();
  return c.json({ ok: true });
}

async function updateLegacyVersionRow(
  db: D1Database,
  appId: string,
  versionId: string,
  body: { enabled?: boolean; channel?: string; should_force_update?: boolean },
) {
  const updates: string[] = [];
  const binds: (string | number)[] = [];
  if (body.enabled !== undefined) {
    updates.push(`enabled = ?${binds.length + 1}`);
    binds.push(body.enabled ? 1 : 0);
  }
  if (body.channel !== undefined) {
    updates.push(`channel = ?${binds.length + 1}`);
    binds.push(body.channel);
  }
  if (body.should_force_update !== undefined) {
    updates.push(`should_force_update = ?${binds.length + 1}`);
    binds.push(body.should_force_update ? 1 : 0);
  }
  if (updates.length === 0) throw new Error("nothing to update");
  binds.push(versionId, appId);
  await db.prepare(
    `UPDATE versions SET ${updates.join(", ")} WHERE id = ?${binds.length - 1} AND app_id = ?${binds.length}`,
  )
    .bind(...binds)
    .run();
}

async function createPublishOperation(
  db: D1Database,
  appId: string,
  actor: string,
  body: LegacyVersionPayload,
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO operation_logs
     (id, app_id, kind, status, parent_op_id, step_number, actor,
      input, output, error, progress, retry_count, created_at, updated_at, completed_at)
     VALUES (?1, ?2, 'publish', 'in_progress', NULL, NULL, ?3, ?4, '{}', NULL, 0.3, 0, ?5, ?6, NULL)`,
  )
    .bind(id, appId, actor, JSON.stringify(body), now, now)
    .run();
  return { id };
}

async function completePublishOperation(db: D1Database, opId: string, releaseId: string) {
  const now = Date.now();
  await db.prepare(
    "UPDATE operation_logs SET status = 'success', progress = 1, output = ?1, updated_at = ?2, completed_at = ?3 WHERE id = ?4",
  )
    .bind(JSON.stringify({ version_id: releaseId, release_id: releaseId }), now, now, opId)
    .run();
}

async function failPublishOperation(db: D1Database, opId: string, message: string) {
  const now = Date.now();
  await db.prepare(
    "UPDATE operation_logs SET status = 'failed', progress = 1, error = ?1, updated_at = ?2, completed_at = ?3 WHERE id = ?4",
  )
    .bind(message, now, now, opId)
    .run();
}

async function generateSignedR2Url(env: Env, key: string, ttlSeconds: number): Promise<string> {
  return `/api/r2/${encodeURIComponent(key)}?expires=${Math.floor(Date.now() / 1000) + ttlSeconds}`;
}
