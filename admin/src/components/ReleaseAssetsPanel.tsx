/**
 * ReleaseAssetsPanel — multi-asset uploader for a release row.
 *
 * The release-first publish flow:
 *   1. "+ New release" dialog creates a release with build (no assets yet).
 *   2. Each ReleaseRow renders this panel as a collapsible section.
 *   3. User drags N APK / dmg / deb / exe files into the drop zone.
 *   4. For each file: upload bytes to R2 + register asset for the build.
 *   5. Per-asset overrides (arch, variant, filetype) can be edited in a row.
 *
 * One release can have many assets (Android multi-arch, Electron multi-OS).
 */

import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createBuildAsset,
  deleteBuildAsset,
  listBuildAssets,
  uploadApk,
  type BuildAsset,
} from "../lib/api";
import { useToast } from "./Toast";

interface Props {
  appId: string;
  releaseId: string;
  buildId: string;
  /** Platform hint used as the default when auto-detecting from filename. */
  productTypeHint: string;
}

interface PendingFile {
  file: File;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
  status: "pending" | "uploading" | "registering" | "done" | "error";
  error?: string;
  assetId?: string;
}

const KNOWN_ARCHES_ANDROID = [
  "arm64-v8a",
  "armeabi-v7a",
  "x86",
  "x86_64",
] as const;
const KNOWN_ARCHES_ELECTRON = [
  "arm64",
  "x64",
  "ia32",
  "universal",
] as const;
const KNOWN_FILETYPES = [
  "apk",
  "aab",
  "ipa",
  "dmg",
  "pkg",
  "exe",
  "msi",
  "deb",
  "rpm",
  "AppImage",
  "zip",
  "tar.gz",
  "bundle",
] as const;

function detectFromFilename(filename: string): {
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
} {
  const lower = filename.toLowerCase();
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  // Android: arch tokens commonly appear before the extension.
  // e.g. myapp-arm64-v8a-release.apk, app-armeabi-v7a.apk, app-x86_64.apk
  let arch: string | null = null;
  for (const a of KNOWN_ARCHES_ANDROID) {
    const token = a.replace("_", "[-_]?");
    if (new RegExp(`[-_]${token}(?=[-_.]|$)`, "i").test(lower)) {
      arch = a;
      break;
    }
  }
  let platform = "android";
  let filetype = ext || "apk";
  if (["dmg", "pkg"].includes(ext) || lower.includes("darwin") || lower.includes("macos")) {
    platform = "darwin";
    for (const a of KNOWN_ARCHES_ELECTRON) {
      if (lower.includes(`-${a}`) || lower.includes(`_${a}`)) {
        arch = a;
        break;
      }
    }
    if (arch == null) arch = "universal";
    filetype = ext === "pkg" ? "pkg" : "dmg";
  } else if (["exe", "msi"].includes(ext) || lower.includes("win32") || lower.includes("windows")) {
    platform = "win32";
    arch = KNOWN_ARCHES_ELECTRON.find((a) => lower.includes(a)) ?? "x64";
    filetype = ext === "msi" ? "msi" : "exe";
  } else if (["deb", "rpm", "appimage"].includes(ext) || lower.includes("linux")) {
    platform = "linux";
    arch = KNOWN_ARCHES_ELECTRON.find((a) => lower.includes(a)) ?? "x64";
    filetype = ext === "rpm" ? "rpm" : ext === "appimage" ? "AppImage" : "deb";
  } else if (ext === "ipa") {
    platform = "ios";
    filetype = "ipa";
  } else if (ext === "aab") {
    platform = "android";
    filetype = "aab";
  } else if (ext === "bundle") {
    platform = "rn-bundle";
    filetype = "bundle";
  }
  return { platform, arch, variant: null, filetype };
}

export function ReleaseAssetsPanel({ appId, releaseId, buildId, productTypeHint }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);

  const assets = useQuery({
    queryKey: ["build-assets", appId, buildId],
    queryFn: () => listBuildAssets(appId, buildId),
  });

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["build-assets", appId, buildId] });
    qc.invalidateQueries({ queryKey: ["release-detail", releaseId] });
    qc.invalidateQueries({ queryKey: ["releases", appId] });
  }, [qc, appId, buildId, releaseId]);

  const remove = useMutation({
    mutationFn: (assetId: string) => deleteBuildAsset(appId, buildId, assetId),
    onSuccess: () => {
      toast.show({ kind: "success", title: "Asset removed" });
      refresh();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Delete failed",
        description: (e as Error).message,
      }),
  });

  const ingestFiles = useCallback(
    async (files: File[]) => {
      const initial: PendingFile[] = files.map((f) => {
        const det = detectFromFilename(f.name);
        return {
          file: f,
          platform: productTypeHint || det.platform,
          arch: det.arch,
          variant: det.variant,
          filetype: det.filetype,
          status: "pending",
        };
      });
      setPending((cur) => [...cur, ...initial]);

      for (let i = 0; i < initial.length; i++) {
        const slot = initial[i];
        if (!slot) continue;
        const setStatus = (s: PendingFile["status"], extra?: Partial<PendingFile>) => {
          setPending((cur) =>
            cur.map((p) =>
              p === slot ? { ...p, status: s, ...extra } : p,
            ),
          );
        };
        try {
          setStatus("uploading");
          const uploaded = await uploadApk(appId, slot.file);
          setStatus("registering");
          const asset = await createBuildAsset(appId, buildId, {
            platform: slot.platform,
            arch: slot.arch,
            variant: slot.variant,
            filetype: slot.filetype,
            r2_key: uploaded.r2_key,
            file_hash: uploaded.file_hash,
            size_bytes: uploaded.size_bytes,
          });
          setStatus("done", { assetId: asset.id });
        } catch (e) {
          setStatus("error", { error: (e as Error).message });
        }
      }
      toast.show({
        kind: "success",
        title: `Uploaded ${initial.length} asset(s)`,
      });
      refresh();
    },
    [appId, buildId, productTypeHint, toast, refresh],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) void ingestFiles(files);
    },
    [ingestFiles],
  );

  const existing = assets.data?.assets ?? [];
  const totalBytes = existing.reduce((s, a) => s + a.size_bytes, 0);

  return (
    <div className="mt-2 pt-2 border-t border-slate-100">
      <div className="flex items-center justify-between mb-2 text-xs text-slate-500">
        <span>
          {existing.length} asset{existing.length === 1 ? "" : "s"} ·{" "}
          {(totalBytes / 1024 / 1024).toFixed(2)} MB total
        </span>
      </div>

      {existing.length > 0 && (
        <table className="w-full text-xs mb-2">
          <thead>
            <tr className="text-slate-500 text-left border-b border-slate-100">
              <th className="font-normal pr-2 py-1">Platform</th>
              <th className="font-normal pr-2 py-1">Arch</th>
              <th className="font-normal pr-2 py-1">Variant</th>
              <th className="font-normal pr-2 py-1">Filetype</th>
              <th className="font-normal pr-2 py-1">Size</th>
              <th className="font-normal pr-2 py-1">r2_key</th>
              <th className="font-normal pr-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {existing.map((a: BuildAsset) => (
              <tr key={a.id} className="border-b border-slate-50">
                <td className="pr-2 py-1 font-mono">{a.platform}</td>
                <td className="pr-2 py-1 font-mono">{a.arch ?? "—"}</td>
                <td className="pr-2 py-1 font-mono">{a.variant ?? "—"}</td>
                <td className="pr-2 py-1 font-mono">{a.filetype}</td>
                <td className="pr-2 py-1 font-mono">
                  {(a.size_bytes / 1024 / 1024).toFixed(2)} MB
                </td>
                <td className="pr-2 py-1 font-mono truncate max-w-[20ch]">
                  {a.r2_key}
                </td>
                <td className="pr-2 py-1">
                  <button
                    className="btn-secondary text-[10px]"
                    onClick={() => {
                      if (confirm("Remove this asset?"))
                        remove.mutate(a.id);
                    }}
                    disabled={remove.isPending}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`cursor-pointer rounded border-2 border-dashed p-4 text-center text-xs transition-colors ${
          dragOver
            ? "border-blue-500 bg-blue-50 text-blue-700"
            : "border-slate-200 text-slate-500 hover:border-slate-400"
        }`}
      >
        Drop APK / dmg / deb / exe here, or click to choose. Multiple files OK.
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void ingestFiles(files);
          e.target.value = "";
        }}
      />

      {/* Per-file progress / override editor */}
      {pending.length > 0 && (
        <div className="mt-2 space-y-1">
          {pending.map((p, idx) => (
            <PendingRow
              key={`${p.file.name}-${idx}`}
              pending={p}
              onChange={(patch) =>
                setPending((cur) =>
                  cur.map((x, i) => (i === idx ? { ...x, ...patch } : x)),
                )
              }
              onRemove={() =>
                setPending((cur) => cur.filter((_, i) => i !== idx))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PendingRow({
  pending,
  onChange,
  onRemove,
}: {
  pending: PendingFile;
  onChange: (patch: Partial<PendingFile>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs bg-slate-50 rounded p-1.5">
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${
          pending.status === "done"
            ? "bg-green-500"
            : pending.status === "error"
              ? "bg-red-500"
              : "bg-blue-500 animate-pulse"
        }`}
      />
      <span className="font-mono truncate flex-1 min-w-0">
        {pending.file.name}
      </span>
      <select
        className="input !py-0.5 !text-xs w-24"
        value={pending.platform}
        disabled={pending.status !== "pending"}
        onChange={(e) => onChange({ platform: e.target.value })}
      >
        {["android", "ios", "darwin", "linux", "win32", "rn-bundle"].map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <input
        className="input !py-0.5 !text-xs w-24"
        placeholder="arch"
        value={pending.arch ?? ""}
        disabled={pending.status !== "pending"}
        onChange={(e) => onChange({ arch: e.target.value || null })}
      />
      <input
        className="input !py-0.5 !text-xs w-20"
        placeholder="variant"
        value={pending.variant ?? ""}
        disabled={pending.status !== "pending"}
        onChange={(e) => onChange({ variant: e.target.value || null })}
      />
      <select
        className="input !py-0.5 !text-xs w-20"
        value={pending.filetype}
        disabled={pending.status !== "pending"}
        onChange={(e) => onChange({ filetype: e.target.value })}
      >
        {KNOWN_FILETYPES.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      {pending.status === "error" && (
        <span className="text-red-600 text-[10px] truncate max-w-[20ch]">
          {pending.error}
        </span>
      )}
      <button
        className="text-slate-400 hover:text-red-600 text-xs"
        onClick={onRemove}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
