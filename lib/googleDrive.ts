import { promises as fs, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { DATA_ROOT } from "@/lib/session";

/**
 * Google Drive integration — dependency-free OAuth 2.0 (authorization-code +
 * refresh) and Drive REST v3. One personal/Workspace account connects once;
 * the refresh token is persisted to a file OUTSIDE the per-session folders
 * (so the single-session wipe never deletes it) and survives restarts.
 *
 * Scope is read-only; we only list + download source clips.
 */

const SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const TOKEN_FILE = path.join(DATA_ROOT, "google-drive.json"); // dotless collision-safe (see session wipe)

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

interface StoredToken {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number; // epoch ms
  email?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  isVideo: boolean;
  isImage: boolean;
  sizeBytes?: number;
  durationMs?: number;
  thumbnailLink?: string;
  modifiedTime?: string;
}

export function driveConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/api/drive/callback",
  };
}

export function isConfigured(): boolean {
  const c = driveConfig();
  return !!(c.clientId && c.clientSecret);
}

/* ------------------------------ token store ------------------------------ */

async function loadToken(): Promise<StoredToken | null> {
  try {
    return JSON.parse(await fs.readFile(TOKEN_FILE, "utf8")) as StoredToken;
  } catch {
    return null;
  }
}
async function saveToken(t: StoredToken): Promise<void> {
  await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await fs.writeFile(TOKEN_FILE, JSON.stringify(t, null, 2), "utf8");
}
async function clearToken(): Promise<void> {
  await fs.rm(TOKEN_FILE, { force: true });
}

/* -------------------------------- OAuth ---------------------------------- */

/** The Google consent URL. offline + prompt=consent guarantees a refresh token. */
export function getAuthUrl(): string {
  const c = driveConfig();
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

/** Exchange the auth code for tokens, fetch the account email, and persist. */
export async function exchangeCode(code: string): Promise<void> {
  const c = driveConfig();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  if (!j.refresh_token) {
    // Google only returns a refresh token on first consent; prompt=consent
    // forces it, but guard anyway so we don't wipe an existing one.
    const existing = await loadToken();
    if (!existing?.refreshToken) throw new Error("Google did not return a refresh token. Revoke access and reconnect.");
    await saveToken({ ...existing, accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 });
  } else {
    await saveToken({ refreshToken: j.refresh_token, accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 });
  }
  // Best-effort: record which account is connected.
  try {
    const token = await getAccessToken();
    const who = await fetch(`${DRIVE_API}/about?fields=user(emailAddress,displayName)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (who.ok) {
      const info = (await who.json()) as { user?: { emailAddress?: string } };
      const t = await loadToken();
      if (t && info.user?.emailAddress) await saveToken({ ...t, email: info.user.emailAddress });
    }
  } catch {
    /* email is cosmetic */
  }
}

/** A valid access token, refreshing via the stored refresh token when stale. */
export async function getAccessToken(): Promise<string> {
  const t = await loadToken();
  if (!t?.refreshToken) throw new Error("NOT_CONNECTED");
  if (t.accessToken && t.expiresAt && t.expiresAt > Date.now() + 60_000) return t.accessToken;
  const c = driveConfig();
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: t.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    // invalid_grant → refresh token revoked/expired; force reconnect.
    if (res.status === 400 || res.status === 401) await clearToken();
    throw new Error("NOT_CONNECTED");
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  await saveToken({ ...t, accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

export async function getStatus(): Promise<{ configured: boolean; connected: boolean; email?: string }> {
  if (!isConfigured()) return { configured: false, connected: false };
  const t = await loadToken();
  return { configured: true, connected: !!t?.refreshToken, email: t?.email };
}

/** Revoke the token at Google and delete the local copy (full disconnect). */
export async function disconnect(): Promise<void> {
  const t = await loadToken();
  if (t?.refreshToken) {
    try {
      await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(t.refreshToken)}`, { method: "POST" });
    } catch {
      /* revoke best-effort; still clear locally */
    }
  }
  await clearToken();
}

/* ------------------------------- Drive REST ------------------------------ */

function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function toDriveFile(f: Record<string, unknown>): DriveFile {
  const mimeType = String(f.mimeType ?? "");
  const isFolder = mimeType === "application/vnd.google-apps.folder";
  const vmeta = f.videoMediaMetadata as { durationMillis?: string } | undefined;
  return {
    id: String(f.id),
    name: String(f.name ?? ""),
    mimeType,
    isFolder,
    isVideo: mimeType.startsWith("video/"),
    isImage: mimeType.startsWith("image/"),
    sizeBytes: f.size ? Number(f.size) : undefined,
    durationMs: vmeta?.durationMillis ? Number(vmeta.durationMillis) : undefined,
    thumbnailLink: f.thumbnailLink ? String(f.thumbnailLink) : undefined,
    modifiedTime: f.modifiedTime ? String(f.modifiedTime) : undefined,
  };
}

/**
 * List Drive entries. Shows folders + video/image files only.
 *  - folderId: browse a folder's children (default "root").
 *  - recent: ignore folder, list recently-viewed videos/images.
 *  - search: match name substring across the whole Drive.
 */
export async function driveList(opts: {
  folderId?: string;
  recent?: boolean;
  search?: string;
}): Promise<{ files: DriveFile[] }> {
  const token = await getAccessToken();
  const mediaFilter = "(mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'video/' or mimeType contains 'image/')";
  let q: string;
  let orderBy: string;
  if (opts.search && opts.search.trim()) {
    q = `name contains '${escapeQ(opts.search.trim())}' and trashed = false and ${mediaFilter}`;
    orderBy = "folder,name";
  } else if (opts.recent) {
    q = `trashed = false and (mimeType contains 'video/' or mimeType contains 'image/')`;
    orderBy = "viewedByMeTime desc,modifiedTime desc";
  } else {
    const folder = opts.folderId || "root";
    q = `'${escapeQ(folder)}' in parents and trashed = false and ${mediaFilter}`;
    orderBy = "folder,name";
  }
  const params = new URLSearchParams({
    q,
    orderBy,
    pageSize: "200",
    fields: "files(id,name,mimeType,size,modifiedTime,thumbnailLink,videoMediaMetadata)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    corpora: "allDrives",
    spaces: "drive",
  });
  const res = await fetch(`${DRIVE_API}/files?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive list failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { files?: Record<string, unknown>[] };
  return { files: (j.files ?? []).map(toDriveFile) };
}

export async function driveFileMeta(fileId: string): Promise<DriveFile> {
  const token = await getAccessToken();
  const params = new URLSearchParams({
    fields: "id,name,mimeType,size,modifiedTime,thumbnailLink,videoMediaMetadata",
    supportsAllDrives: "true",
  });
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive metadata failed (${res.status})`);
  return toDriveFile((await res.json()) as Record<string, unknown>);
}

/** Stream a Drive file's bytes to a local path (never buffers whole file). */
export async function driveDownloadToFile(fileId: string, destAbs: string, signal?: AbortSignal): Promise<void> {
  const token = await getAccessToken();
  const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Drive download failed (${res.status})`);
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(destAbs));
}
