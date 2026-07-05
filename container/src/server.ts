/**
 * Container server — APK + multi-format metadata parser.
 *
 * Endpoints:
 *   GET  /health       — liveness
 *   POST /parse        — body = raw binary bytes, optional X-Quiver-Filename
 *                        header; optional ?parser_kind=... or
 *                        X-Quiver-Parser-Kind header to force dispatch.
 *                        Auto-detects apk / aab / asar / RN bundle / ELF CLI
 *                        binary and returns { parser_kind, platform, arch,
 *                        version, version_code, package_id, app_label,
 *                        size_bytes, file_hash_sha256, raw }.
 *   POST /parse?parser_kind=... — same as above, but with the dispatch hint
 *                        baked into the URL.
 *
 * Backward compat: the old /parse endpoint returned a flat APK-only shape
 * (package_name, version_name, ...). New shape is namespaced under those
 * same keys when parser_kind === 'apk-aapt' so the v1 admin client still
 * works — the worker just spreads .raw back into the response.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectParserKind,
  parseWithDispatcher,
  type ParserKind,
} from "./parsers/index.js";

const app = new Hono();

const execFileAsync = promisify(execFile);

const RETRACE_BIN = "/opt/android-sdk/cmdline-tools/latest/bin/retrace";

app.get("/health", (c) => c.json({ ok: true, service: "multi-parser" }));

/**
 * POST /retrace — body = { mapping, trace }. Deobfuscates an R8/ProGuard
 * stack trace against the given mapping using the Android SDK retrace tool.
 * Returns { retraced }.
 */
app.post("/retrace", async (c) => {
  let body: { mapping?: string; trace?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const mapping = typeof body.mapping === "string" ? body.mapping : "";
  const trace = typeof body.trace === "string" ? body.trace : "";
  if (!mapping.trim() || !trace.trim()) {
    return c.json({ error: "mapping and trace are required" }, 400);
  }
  if (mapping.length > 200 * 1024 * 1024) {
    return c.json({ error: "mapping too large" }, 413);
  }
  const dir = join(tmpdir(), `retrace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const mappingPath = join(dir, "mapping.txt");
  const tracePath = join(dir, "trace.txt");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(mappingPath, mapping);
    await writeFile(tracePath, trace);
    const { stdout } = await execFileAsync(
      RETRACE_BIN,
      [mappingPath, tracePath],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    return c.json({ retraced: stdout });
  } catch (err) {
    return c.json(
      { error: `retrace failed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  } finally {
    await Promise.allSettled([unlink(mappingPath), unlink(tracePath)]);
  }
});

app.post("/parse", async (c) => {
  const ab = await c.req.arrayBuffer();
  if (ab.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (ab.byteLength > 200 * 1024 * 1024) {
    return c.json({ error: "file too large (>200MB)" }, 413);
  }

  const bytes = new Uint8Array(ab);
  const explicit =
    (c.req.query("parser_kind") as ParserKind | null) ??
    (c.req.header("X-Quiver-Parser-Kind") as ParserKind | null);
  const filename =
    c.req.header("X-Quiver-Filename") ??
    c.req.query("filename") ??
    null;

  const kind = detectParserKind({
    explicit: explicit ?? null,
    filename,
    bytes,
  });

  // For APK we keep the historical behavior of writing to tmpfile so
  // aapt/apksigner can exec on it. Other parsers read bytes directly.
  let tmpDir: string | null = null;
  let tmpPath: string | null = null;
  if (kind === "apk-aapt") {
    tmpDir = join(
      tmpdir(),
      `quiver-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tmpDir, { recursive: true });
    tmpPath = join(tmpDir, "input.bin");
    await writeFile(tmpPath, bytes);
  }

  try {
    const metadata = await parseWithDispatcher({
      parserKind: kind,
      bytes,
      filename,
      filePath: tmpPath,
    });
    // Backward compat: when parser_kind === 'apk-aapt' also surface the
    // historical flat keys (package_name, version_name, ...) so the
    // existing admin UI client doesn't break.
    if (metadata.parser_kind === "apk-aapt") {
      return c.json({
        ...metadata,
        package_name: metadata.package_id,
        version_name: metadata.version,
        signature_sha256: (metadata.raw.signature_sha256 as string) ?? "",
        min_sdk: metadata.raw.min_sdk ?? null,
        target_sdk: metadata.raw.target_sdk ?? null,
      });
    }
    return c.json(metadata);
  } catch (err) {
    console.error("parse error:", err);
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  } finally {
    if (tmpPath) {
      await unlink(tmpPath).catch(() => {});
    }
  }
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`multi-parser listening on :${info.port}`);
});
