export interface R2PresignAsset {
  key: string;
  filetype: string;
  contentDisposition: string;
}

export function canPresignR2Download(env: Env): boolean {
  return Boolean(
    (env.R2_S3_ENDPOINT || env.R2_ACCOUNT_ID) &&
      env.R2_BUCKET_NAME &&
      env.R2_S3_ACCESS_KEY_ID &&
      env.R2_S3_SECRET_ACCESS_KEY,
  );
}

export async function presignR2DownloadUrl(
  env: Env,
  asset: R2PresignAsset,
  ttlSeconds: number,
): Promise<string | null> {
  if (!canPresignR2Download(env)) return null;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const expires = String(Math.max(1, Math.min(Math.floor(ttlSeconds), 604800)));
  const endpoint = r2Endpoint(env);
  const url = new URL(`${endpoint}/${encodeURIComponent(env.R2_BUCKET_NAME!)}/${asset.key.split("/").map(encodeURIComponent).join("/")}`);
  const host = url.host;
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const credential = `${env.R2_S3_ACCESS_KEY_ID!}/${credentialScope}`;

  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", credential);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", expires);
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  url.searchParams.set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD");
  url.searchParams.set("response-content-type", contentTypeForPresignedAsset(asset.filetype));
  url.searchParams.set("response-content-disposition", asset.contentDisposition);

  const canonicalQuery = canonicalQueryString(url.searchParams);
  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = await awsSigningKey(env.R2_S3_SECRET_ACCESS_KEY!, dateStamp);
  const signature = await hmacHex(signingKey, stringToSign);
  url.searchParams.set("X-Amz-Signature", signature);
  return url.toString();
}

function r2Endpoint(env: Env): string {
  const configured = env.R2_S3_ENDPOINT?.replace(/\/+$/, "");
  if (configured) return configured;
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

function canonicalQueryString(params: URLSearchParams): string {
  return Array.from(params.entries())
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function awsSigningKey(secret: string, dateStamp: string): Promise<ArrayBuffer> {
  const kDate = await hmacBytes(`AWS4${secret}`, dateStamp);
  const kRegion = await hmacBytes(kDate, "auto");
  const kService = await hmacBytes(kRegion, "s3");
  return await hmacBytes(kService, "aws4_request");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(digest);
}

async function hmacBytes(key: string | ArrayBuffer, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? new TextEncoder().encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

async function hmacHex(key: ArrayBuffer, value: string): Promise<string> {
  return hex(await hmacBytes(key, value));
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function contentTypeForPresignedAsset(filetype: string): string {
  switch (filetype) {
    case "apk":
      return "application/vnd.android.package-archive";
    case "json":
      return "application/json";
    case "txt":
      return "text/plain; charset=utf-8";
    case "zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}
