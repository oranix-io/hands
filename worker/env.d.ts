/**
 * Extra secret bindings are not emitted by wrangler types, so declare them
 * explicitly. Non-secret vars still live in wrangler.jsonc.
 */

import "@cloudflare/workers-types";

declare global {
  interface Env {
    ADMIN_API_TOKEN?: string;
    RAFT_CLIENT_SECRET?: string;
    RAFT_ORIGIN?: string;
    RAFT_API_ORIGIN?: string;
    RAFT_CLIENT_ID?: string;
    CORS_ALLOWED_ORIGINS?: string;
    SIGNED_URL_SECRET?: string;
    R2_ACCOUNT_ID?: string;
    R2_BUCKET_NAME?: string;
    R2_S3_ENDPOINT?: string;
    R2_S3_ACCESS_KEY_ID?: string;
    R2_S3_SECRET_ACCESS_KEY?: string;
    R2_PRESIGNED_DOWNLOAD_TTL_SECONDS?: string;
    SHARE_STATS_SALT?: string;
    RAFT_ALLOWED_SERVER_IDS?: string;
    RAFT_ALLOWED_SERVER_SLUGS?: string;
  }
}

export {};
