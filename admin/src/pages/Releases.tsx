/**
 * Releases tab — live releases per (channel, product_type, release_type).
 *
 * Wires the new /api/apps/:appId/releases + /releases/:id/{rollback,bump-rollout,force-update}
 * endpoints. Shows: status badge, scope visualization, action buttons.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bumpRollout,
  forceUpdate,
  getRelease,
  listApps,
  listChannels,
  listProductTypes,
  listReleaseTypes,
  listReleases,
  rollbackRelease,
  type Release,
  type ReleaseScope,
} from "../lib/api";
import { useToast } from "../components/Toast";

export function Releases({ appId }: { appId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const app = useQuery({ queryKey: ["apps"], queryFn: () => listApps() });
  const releases = useQuery({
    queryKey: ["releases", appId],
    queryFn: () => listReleases(appId),
  });
  const channels = useQuery({
    queryKey: ["channels", appId],
    queryFn: () => listChannels(appId),
  });
  const productTypes = useQuery({
    queryKey: ["product-types", appId],
    queryFn: () => listProductTypes(appId),
  });
  const releaseTypes = useQuery({
    queryKey: ["release-types", appId],
    queryFn: () => listReleaseTypes(appId),
  });

  const thisApp = app.data?.apps.find((a) => a.id === appId);

  // Filter client-side (expert's endpoint may or may not accept filter params;
  // we keep filtering here for v1 simplicity)
  const filtered = (releases.data?.releases ?? []).filter((r) => {
    if (channelFilter !== "all") {
      const ch = channels.data?.channels.find((c) => c.id === r.channel_id);
      if (ch?.slug !== channelFilter) return false;
    }
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    return true;
  });

  return (
    <div>
      <div className="mb-6">
        <div className="text-sm text-slate-500">Releases</div>
        <h1 className="text-2xl font-bold">
          {thisApp?.name ?? "..."}
          <span className="badge-blue align-middle ml-2">{thisApp?.platform}</span>
        </h1>
        <div className="text-sm text-slate-500 font-mono">{thisApp?.slug}</div>
      </div>

      {/* Stats summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Total" value={releases.data?.releases.length ?? 0} />
        <Stat
          label="Active"
          value={releases.data?.releases.filter((r) => r.status === "active").length ?? 0}
        />
        <Stat
          label="Superseded"
          value={releases.data?.releases.filter((r) => r.status === "superseded").length ?? 0}
        />
        <Stat
          label="Channels"
          value={channels.data?.channels.length ?? 0}
        />
      </div>

      {/* Filters */}
      <div className="card !p-3 mb-4 flex flex-wrap gap-3 items-center">
        <select
          className="input w-40"
          value={channelFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
        >
          <option value="all">All channels</option>
          {channels.data?.channels.map((c) => (
            <option key={c.id} value={c.slug}>
              {c.slug}
            </option>
          ))}
        </select>
        <select
          className="input w-40"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="superseded">Superseded</option>
          <option value="rolled_back">Rolled back</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {releases.isLoading && <p className="text-slate-500">Loading…</p>}
      {releases.error && (
        <p className="text-red-600">Failed: {(releases.error as Error).message}</p>
      )}

      {filtered.length === 0 && !releases.isLoading && (
        <p className="text-slate-500 text-sm">
          No releases match your filter. Create a build first via Versions tab
          and promote it to a release.
        </p>
      )}

      <div className="space-y-2">
        {filtered.map((r) => {
          const channel = channels.data?.channels.find((c) => c.id === r.channel_id);
          const pt = productTypes.data?.product_types.find((p) => p.name === r.product_type);
          const rt = releaseTypes.data?.release_types.find((x) => x.name === r.release_type);
          return (
            <ReleaseRow
              key={r.id}
              release={r}
              appId={appId}
              channelSlug={channel?.slug ?? "?"}
              productTypeName={pt?.display_name ?? r.product_type}
              releaseTypeName={rt?.display_name ?? r.release_type}
              releaseTypeColor={rt?.color ?? null}
              onAction={() => {
                qc.invalidateQueries({ queryKey: ["releases", appId] });
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card !p-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function ReleaseRow({
  release: r,
  appId,
  channelSlug,
  productTypeName,
  releaseTypeName,
  releaseTypeColor,
  onAction,
}: {
  release: Release;
  appId: string;
  channelSlug: string;
  productTypeName: string;
  releaseTypeName: string;
  releaseTypeColor: string | null;
  onAction: () => void;
}) {
  const toast = useToast();
  const [showDetail, setShowDetail] = useState(false);
  const [showRollout, setShowRollout] = useState(false);
  const [newPercent, setNewPercent] = useState<number>(r.rollout_cohort_count ?? 100);

  const detail = useQuery({
    queryKey: ["release-detail", r.id],
    queryFn: () => getRelease(appId, r.id),
    enabled: showDetail,
  });

  const rollback = useMutation({
    mutationFn: () => rollbackRelease(appId, r.id, {}),
    onSuccess: () => {
      toast.show({ kind: "success", title: `Rolled back from ${releaseTypeName} ${channelSlug}` });
      onAction();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Rollback failed",
        description: (e as Error).message,
      }),
  });

  const bump = useMutation({
    mutationFn: (target: number) => bumpRollout(appId, r.id, { to: target }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: `Rollout set to ${data.rollout_cohort_count ?? "?"}%`,
      });
      onAction();
      setShowRollout(false);
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Bump rollout failed",
        description: (e as Error).message,
      }),
  });

  const toggleForce = useMutation({
    mutationFn: () => forceUpdate(appId, r.id, { enabled: !r.should_force_update }),
    onSuccess: (data) => {
      toast.show({
        kind: "success",
        title: data.should_force_update
          ? "Now forcing update on clients"
          : "No longer forcing update",
      });
      onAction();
    },
    onError: (e) =>
      toast.show({
        kind: "error",
        title: "Force-update toggle failed",
        description: (e as Error).message,
      }),
  });

  return (
    <div className="card">
      <div className="flex items-center gap-3 flex-wrap">
        <ReleaseStatusBadge status={r.status} />
        {releaseTypeColor && (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: releaseTypeColor }}
          />
        )}
        <span className="font-medium">{releaseTypeName}</span>
        <span className="badge-blue">{channelSlug}</span>
        <span className="text-xs text-slate-500">{productTypeName}</span>
        {r.is_full ? (
          <span className="badge-green text-xs">full</span>
        ) : (
          <span className="badge-orange text-xs">scoped</span>
        )}
        {r.should_force_update ? (
          <span className="badge-orange text-xs">⚠ force</span>
        ) : null}
        {r.rollout_cohort_count != null && r.rollout_cohort_count < 100 && (
          <span className="badge-orange text-xs">
            {r.rollout_cohort_count}% rollout
          </span>
        )}
        <span className="text-xs text-slate-500 ml-auto">
          {new Date(r.created_at).toISOString().slice(0, 16)}Z
        </span>
      </div>
      <div className="text-xs text-slate-500 font-mono mt-1 truncate">
        {r.id} (build {r.build_id.slice(0, 8)}…)
      </div>
      {r.changelog && (
        <details className="text-xs text-slate-600 mt-1">
          <summary className="cursor-pointer hover:text-slate-800">
            {(r.changelog.split("\n")[0] ?? "").slice(0, 80)}
            {r.changelog.split("\n").length > 1 ? "…" : ""}
          </summary>
          <pre className="mt-1 pl-2 border-l-2 border-slate-100 font-mono whitespace-pre-wrap text-xs max-h-32 overflow-y-auto">
            {r.changelog}
          </pre>
        </details>
      )}
      <div className="flex flex-wrap gap-2 mt-2">
        {r.status === "active" && (
          <>
            <button
              className="btn-secondary text-xs"
              onClick={() => setShowRollout(!showRollout)}
            >
              Bump rollout
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={() => toggleForce.mutate()}
              disabled={toggleForce.isPending}
            >
              {r.should_force_update ? "Unforce" : "Force"}
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={() => rollback.mutate()}
              disabled={rollback.isPending}
            >
              Roll back
            </button>
          </>
        )}
        <button
          className="btn-secondary text-xs"
          onClick={() => setShowDetail(!showDetail)}
        >
          {showDetail ? "Hide detail" : "Show detail"}
        </button>
      </div>
      {showRollout && (
        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-2 text-xs">
          <label>Rollout %:</label>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={newPercent}
            onChange={(e) => setNewPercent(Number(e.target.value))}
            className="flex-1"
          />
          <span className="font-mono w-10 text-right">{newPercent}%</span>
          <button
            className="btn-primary text-xs"
            onClick={() => bump.mutate(newPercent)}
            disabled={bump.isPending}
          >
            {bump.isPending ? "…" : "Set"}
          </button>
        </div>
      )}
      {showDetail && detail.data && (
        <div className="mt-2 pt-2 border-t border-slate-100 text-xs">
          <div className="text-slate-500 mb-1">Build: {detail.data.build?.version_name} ({detail.data.build?.version_code})</div>
          <div className="text-slate-500 mb-1">
            Assets: {detail.data.assets.length} · Scopes: {detail.data.scopes.length}
          </div>
          {detail.data.scopes.length > 0 && (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 text-left">
                  <th className="font-normal pr-2">type</th>
                  <th className="font-normal pr-2">value</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.scopes.map((s: ReleaseScope) => (
                  <tr key={s.id}>
                    <td className="pr-2 font-mono">{s.scope_type}</td>
                    <td className="pr-2 font-mono">{s.scope_value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function ReleaseStatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    active: "bg-green-200 text-green-700",
    superseded: "bg-gray-200 text-gray-700",
    rolled_back: "bg-yellow-200 text-yellow-700",
    cancelled: "bg-red-200 text-red-700",
  };
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded ${colorMap[status] ?? "bg-gray-200 text-gray-700"}`}
    >
      {status}
    </span>
  );
}