/**
 * `quiver builds` — list / inspect builds inside an app.
 *
 * Wires GET /api/apps/:appId/builds + GET /api/apps/:appId/builds/:buildId.
 */

import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";

interface BuildRow {
  id: string;
  app_id: string;
  channel_id: string | null;
  product_type: string;
  release_type: string;
  version_name: string;
  version_code: number;
  status: string;
  changelog: string | null;
  should_force_update: number;
  created_at: number;
  completed_at: number | null;
}

export function registerBuildCommands(program: Command): void {
  const builds = program
    .command("builds")
    .description("Inspect builds inside an app.");

  builds
    .command("list <appIdOrSlug>")
    .alias("ls")
    .description("List builds for an app.")
    .option("--limit <n>", "Max rows (default 50)", "50")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: { limit?: string; json?: boolean },
      ) => {
        const id = await resolveAppId(appIdOrSlug);
        const res = await apiRequest<{ builds: BuildRow[] }>(
          `/api/apps/${id}/builds`,
          { query: { limit: opts.limit } },
        );
        if (opts.json) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        if (res.builds.length === 0) {
          console.log("No builds yet.");
          return;
        }
        for (const b of res.builds) {
          const flag = b.should_force_update ? "  [force]" : "";
          console.log(
            `${b.version_name} (${b.version_code})  ${b.product_type}/${b.release_type}  status=${b.status}${flag}  id=${b.id.slice(0, 8)}`,
          );
        }
      },
    );

  builds
    .command("get <appIdOrSlug> <buildId>")
    .description("Show details for a single build.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        buildId: string,
        opts: { json?: boolean },
      ) => {
        const id = await resolveAppId(appIdOrSlug);
        const build = await apiRequest<BuildRow>(`/api/apps/${id}/builds/${buildId}`);
        if (opts.json) {
          console.log(JSON.stringify(build, null, 2));
          return;
        }
        console.log(`${build.version_name} (${build.version_code})`);
        console.log(`  product_type: ${build.product_type}`);
        console.log(`  release_type: ${build.release_type}`);
        console.log(`  status: ${build.status}`);
        console.log(`  should_force_update: ${build.should_force_update ? "yes" : "no"}`);
        console.log(`  created_at: ${new Date(build.created_at).toISOString()}`);
        if (build.completed_at) {
          console.log(
            `  completed_at: ${new Date(build.completed_at).toISOString()}`,
          );
        }
        if (build.changelog) {
          console.log(`\n  changelog:\n${build.changelog.split("\n").map((l) => "    " + l).join("\n")}`);
        }
      },
    );
}

async function resolveAppId(slugOrId: string): Promise<string> {
  if (slugOrId.length === 36 && slugOrId.split("-").length === 5) {
    return slugOrId;
  }
  const res = await apiRequest<{
    apps: Array<{ id: string; slug: string }>;
  }>("/api/apps");
  const match = res.apps.find((a) => a.slug === slugOrId);
  if (!match) {
    console.error(`No app with slug '${slugOrId}'.`);
    process.exit(1);
  }
  return match.id;
}
