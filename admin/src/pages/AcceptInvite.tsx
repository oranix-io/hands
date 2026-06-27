/**
 * AcceptInvite — public magic-link landing page.
 *
 * URL: /invites/:token
 * If not signed in, "Sign in with Raft to accept" button.
 * After accept: redirect to /apps/:appId or / (org dashboard).
 *
 * Scaffold: UI is laid out. Real data wiring (call /api/invites/:token +
 * /api/invites/:token/accept) will land after expert completes P5.3.
 */

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getAuthMe, loginUrl } from "../lib/api";

interface InviteDetails {
  id: string;
  org_id: string;
  app_id: string | null;
  email: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  message: string | null;
  created_at: number;
  expires_at: number;
  invited_by_display_name: string;
  org_name: string;
  app_name: string | null;
}

export function AcceptInvite({ token }: { token: string }) {
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ["auth-me"], queryFn: () => getAuthMe() });
  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch invite details on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // TODO: wire to GET /api/invites/:token (P5.3)
        const res = await fetch(`/api/invites/${token}`);
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.text();
          throw new Error(body || `invite fetch failed ${res.status}`);
        }
        const data = (await res.json()) as InviteDetails;
        setInvite(data);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = useMutation({
    mutationFn: async () => {
      // TODO: wire to POST /api/invites/:token/accept (P5.3)
      const res = await fetch(`/api/invites/${token}/accept`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `accept failed ${res.status}`);
      }
      return res.json() as Promise<{ app_id: string | null; org_id: string }>;
    },
    onSuccess: (data) => {
      navigate(data.app_id ? `/apps/${data.app_id}` : "/");
    },
    onError: (e) =>
      setError((e as Error).message),
  });

  if (loading) {
    return (
      <div className="max-w-md mx-auto mt-20 p-4 text-center text-slate-500">
        Loading invite…
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-md mx-auto mt-20 p-4">
        <div className="card !p-4 text-red-600 text-sm">
          <strong>Invite error:</strong> {error}
        </div>
      </div>
    );
  }

  if (!invite) return null;

  const isExpired = invite.expires_at < Date.now();
  const isAccepted = invite.status === "accepted";
  const isRevoked = invite.status === "revoked";

  return (
    <div className="max-w-md mx-auto mt-20 p-4">
      <div className="card !p-6">
        <h1 className="text-xl font-bold mb-2">You've been invited</h1>
        <p className="text-sm text-slate-600 mb-4">
          <strong>{invite.invited_by_display_name}</strong> invited you to join{" "}
          <strong>{invite.org_name}</strong>
          {invite.app_name ? (
            <>
              {" "}with access to <strong>{invite.app_name}</strong> as{" "}
              <strong>{invite.role}</strong>
            </>
          ) : (
            <>
              {" "}as <strong>{invite.role}</strong>
            </>
          )}
          .
        </p>

        {invite.message && (
          <blockquote className="border-l-2 border-slate-200 pl-3 my-4 text-sm text-slate-600 italic">
            {invite.message}
          </blockquote>
        )}

        {isExpired && (
          <p className="text-sm text-red-600 my-4">
            This invite expired on{" "}
            {new Date(invite.expires_at).toISOString().slice(0, 16)}Z. Ask the
            inviter to send a new one.
          </p>
        )}
        {isAccepted && (
          <p className="text-sm text-green-600 my-4">
            ✓ You've already accepted this invite.
          </p>
        )}
        {isRevoked && (
          <p className="text-sm text-red-600 my-4">
            This invite was revoked by the inviter.
          </p>
        )}

        {!me.data?.authenticated && !isExpired && !isAccepted && !isRevoked && (
          <a
            href={loginUrl(`/invites/${token}`)}
            className="btn-primary block text-center mt-4"
          >
            Sign in with Raft to accept
          </a>
        )}

        {me.data?.authenticated &&
          !isExpired &&
          !isAccepted &&
          !isRevoked && (
            <button
              className="btn-primary w-full mt-4"
              onClick={() => accept.mutate()}
              disabled={accept.isPending}
            >
              {accept.isPending ? "Accepting…" : "Accept invite"}
            </button>
          )}

        <p className="text-xs text-slate-400 mt-4">
          Token: <code>{token.slice(0, 12)}…</code> · Expires{" "}
          {new Date(invite.expires_at).toISOString().slice(0, 16)}Z
        </p>
      </div>
    </div>
  );
}