/**
 * /api/apps/:appId/release-types — list / create / update / delete release types
 *
 * A release type = "how to label releases" (stable, rc, beta, internal, ...)
 * User-defined per app. See docs/publish-architecture.md v3 §3.4.
 */

import type { Context } from "hono";
import { currentActor } from "../middleware/auth";

export async function handleListReleaseTypes(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const { results } = await c.env.DB.prepare(
    `SELECT id, app_id, name, display_name, color, description, created_at, updated_at
     FROM release_types WHERE app_id = ?1 ORDER BY display_name ASC`,
  ).bind(appId).all();
  return c.json({ release_types: results });
}

export async function handleCreateReleaseType(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json()) as {
    name: string;
    display_name: string;
    color?: string;
    description?: string;
  };
  if (!body.name || !body.display_name) {
    return c.json({ error: "name, display_name required" }, 400);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO release_types
     (id, app_id, name, display_name, color, description, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(
    id,
    appId,
    body.name,
    body.display_name,
    body.color ?? null,
    body.description ?? null,
    now,
    now,
  ).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(
    crypto.randomUUID(),
    appId,
    "release_type.create",
    currentActor(c),
    JSON.stringify(body),
    now,
  ).run();

  return c.json(
    {
      id,
      app_id: appId,
      name: body.name,
      display_name: body.display_name,
      color: body.color ?? null,
    },
    201,
  );
}

export async function handleUpdateReleaseType(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const rtId = c.req.param("rtId") ?? "";
  const body = (await c.req.json()) as {
    display_name?: string;
    color?: string | null;
    description?: string | null;
  };

  const updates: string[] = [];
  const binds: (string | number | null)[] = [];
  if (body.display_name !== undefined) {
    updates.push(`display_name = ?${binds.length + 1}`);
    binds.push(body.display_name);
  }
  if (body.color !== undefined) {
    updates.push(`color = ?${binds.length + 1}`);
    binds.push(body.color || null);
  }
  if (body.description !== undefined) {
    updates.push(`description = ?${binds.length + 1}`);
    binds.push(body.description || null);
  }
  if (updates.length === 0) return c.json({ error: "nothing to update" }, 400);

  updates.push(`updated_at = ?${binds.length + 1}`);
  binds.push(Date.now());
  binds.push(rtId, appId);

  await c.env.DB.prepare(
    `UPDATE release_types SET ${updates.join(", ")} WHERE id = ?${binds.length - 1} AND app_id = ?${binds.length}`,
  ).bind(...binds).run();

  return c.json({ ok: true });
}

export async function handleDeleteReleaseType(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const rtId = c.req.param("rtId") ?? "";

  // Refuse if any releases use this release_type
  const releaseCount = await c.env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM releases WHERE app_id = ?1 AND release_type = (SELECT name FROM release_types WHERE id = ?2 AND app_id = ?1)",
  ).bind(appId, rtId).first<{ cnt: number }>();
  if (releaseCount && releaseCount.cnt > 0) {
    return c.json(
      { error: `cannot delete release_type with ${releaseCount.cnt} release(s)` },
      409,
    );
  }

  await c.env.DB.prepare(
    "DELETE FROM release_types WHERE id = ?1 AND app_id = ?2",
  ).bind(rtId, appId).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(
    crypto.randomUUID(),
    appId,
    "release_type.delete",
    currentActor(c),
    JSON.stringify({ release_type_id: rtId }),
    Date.now(),
  ).run();

  return c.json({ ok: true });
}