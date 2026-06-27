/**
 * /api/apps — CRUD on app definitions
 *
 * An "app" = a logical application (e.g., `myapp-android`).
 * Each app has many versions and channels.
 */

import type { Context } from "hono";
import { currentActor } from "../middleware/auth";

export async function handleListApps(c: Context<{ Bindings: Env }>) {
  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, name, platform, description, archived, archived_at, created_at
     FROM apps ORDER BY archived ASC, created_at DESC`,
  ).all<{
    id: string;
    slug: string;
    name: string;
    platform: string;
    description: string | null;
    archived: number;
    archived_at: number | null;
    created_at: number;
  }>();
  return c.json({ apps: results });
}

export async function handleCreateApp(c: Context<{ Bindings: Env }>) {
  const body = (await c.req.json()) as {
    slug: string;
    name: string;
    platform: string;
    description?: string;
  };
  if (!body.slug || !body.name || !body.platform) {
    return c.json({ error: "slug, name, platform required" }, 400);
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO apps (id, slug, name, platform, description, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(id, body.slug, body.name, body.platform, body.description ?? null, Date.now()).run();

  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      id,
      "app.create",
      currentActor(c),
      JSON.stringify(body),
      Date.now(),
    )
    .run();

  return c.json({ id, slug: body.slug, name: body.name, platform: body.platform }, 201);
}

export async function handleArchiveApp(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as { archived?: boolean };
  const targetArchived = body.archived !== false; // default to true (archive action)
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE apps SET archived = ?1, archived_at = CASE WHEN ?1 = 1 THEN ?2 ELSE NULL END WHERE id = ?3`,
  ).bind(targetArchived ? 1 : 0, now, appId).run();
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      targetArchived ? "app.archive" : "app.unarchive",
      currentActor(c),
      JSON.stringify({ archived: targetArchived }),
      now,
    )
    .run();
  return c.json({ ok: true, archived: targetArchived });
}

export async function handleGetApp(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT id, slug, name, platform, description, archived, archived_at, created_at
     FROM apps WHERE id = ?1`,
  ).bind(appId).first<{
    id: string;
    slug: string;
    name: string;
    platform: string;
    description: string | null;
    archived: number;
    archived_at: number | null;
    created_at: number;
  }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
}
