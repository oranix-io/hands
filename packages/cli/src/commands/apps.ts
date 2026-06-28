/**
 * `quiver apps` — list / inspect apps in the caller's org.
 *
 * Wires GET /api/apps + GET /api/apps/:appId.
 */

import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";

interface AppRow {
  id: string;
  slug: string;
  name: string;
  platform: string;
  archived: number;
  default_channel_slug: string | null;
  created_at: number;
}

export function registerAppCommands(program: Command): void {
  const apps = program.command("apps").description("Manage apps in your org.");

  apps
    .command("list")
    .alias("ls")
    .description("List apps in the current org.")
    .option("--include-archived", "Include archived (soft-deleted) apps.", false)
    .option("--json", "Output JSON.", false)
    .action(async (opts: { includeArchived?: boolean; json?: boolean }) => {
      const res = await apiRequest<{ apps: AppRow[] }>("/api/apps", {
        query: { include_archived: opts.includeArchived ? "1" : "0" },
      });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.apps.length === 0) {
        console.log("No apps. Create one in the admin UI first.");
        return;
      }
      console.log(
        ["SLUG", "PLATFORM", "ARCHIVED", "DEFAULT_CHANNEL", "ID"].join("\t"),
      );
      for (const a of res.apps) {
        console.log(
          [
            a.slug,
            a.platform,
            a.archived ? "yes" : "no",
            a.default_channel_slug ?? "—",
            a.id.slice(0, 8),
          ].join("\t"),
        );
      }
    });

  apps
    .command("get <appIdOrSlug>")
    .description("Show details for a single app.")
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: { json?: boolean }) => {
      // The Worker endpoint accepts UUID; for slug we list + filter.
      // Cheap heuristic: 36-char with dashes = UUID.
      const isUuid =
        appIdOrSlug.length === 36 && appIdOrUuidDash(appIdOrSlug);
      let id = appIdOrSlug;
      if (!isUuid) {
        const res = await apiRequest<{ apps: AppRow[] }>("/api/apps");
        const match = res.apps.find((a) => a.slug === appIdOrSlug);
        if (!match) {
          console.error(`No app with slug '${appIdOrSlug}'.`);
          process.exit(1);
        }
        id = match.id;
      }
      const app = await apiRequest<AppRow>(`/api/apps/${id}`);
      if (opts.json) {
        console.log(JSON.stringify(app, null, 2));
        return;
      }
      console.log(`${app.name}  (${app.platform})`);
      console.log(`  id: ${app.id}`);
      console.log(`  slug: ${app.slug}`);
      console.log(`  archived: ${app.archived ? "yes" : "no"}`);
      console.log(
        `  default_channel: ${app.default_channel_slug ?? "(none)"}`,
      );
    });
}

function appIdOrUuidDash(s: string): boolean {
  return s.split("-").length === 5;
}
