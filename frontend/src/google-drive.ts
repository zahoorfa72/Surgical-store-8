import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_KEY = "ssm.google-drive.token.v2";
const FOLDER_KEY = "ssm.google-drive.folder.v2";
const BACKUP_NAME_PREFIX = "SurgicalStore-";
const CLIENT_ID_KEY = "ssm.google-drive.client-id.v1";

const discovery = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revocationEndpoint: "https://oauth2.googleapis.com/revoke",
};

export type GoogleDriveToken = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  issuedAt?: number;
  tokenType?: string;
};

export function googleDriveClientId(): string | null {
  const id =
    Platform.OS === "android"
      ? process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID
      : Platform.OS === "ios"
        ? process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
        : process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  return id?.trim() || null;
}

async function getEffectiveGoogleDriveClientId(): Promise<string | null> {
  const envId = googleDriveClientId();
  if (envId) return envId;
  try {
    const stored = await SecureStore.getItemAsync(CLIENT_ID_KEY);
    return stored?.trim() || null;
  } catch {
    return null;
  }
}

export async function getStoredGoogleDriveClientId(): Promise<string | null> {
  try {
    const id = await SecureStore.getItemAsync(CLIENT_ID_KEY);
    return id?.trim() || null;
  } catch {
    return null;
  }
}

export async function setGoogleDriveClientId(clientId: string): Promise<void> {
  const id = clientId.trim();
  if (!id) throw new Error("Google OAuth Client ID cannot be empty.");
  await SecureStore.setItemAsync(CLIENT_ID_KEY, id);
}

export async function clearGoogleDriveClientId(): Promise<void> {
  await SecureStore.deleteItemAsync(CLIENT_ID_KEY);
}

export function googleDriveRedirectUri(): string {
  return AuthSession.makeRedirectUri({ scheme: "frontend" });
}

export async function saveGoogleDriveToken(token: GoogleDriveToken): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(token));
}

export async function clearGoogleDriveConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(FOLDER_KEY);
}

export async function hasGoogleDriveConnection(): Promise<boolean> {
  const token = await readToken();
  return !!token?.refreshToken || !!token?.accessToken;
}

async function readToken(): Promise<GoogleDriveToken | null> {
  const raw = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GoogleDriveToken;
  } catch {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    return null;
  }
}

async function getAccessToken(): Promise<string | null> {
  const token = await readToken();
  if (!token) return null;

  const issuedAt = Number(token.issuedAt ?? 0);
  const expiresIn = Number(token.expiresIn ?? 0);
  const now = Math.floor(Date.now() / 1000);
  const freshUntil = issuedAt + Math.max(0, expiresIn - 300);

  if (token.accessToken && (!expiresIn || now < freshUntil)) return token.accessToken;

  if (!token.refreshToken) return token.accessToken ?? null;
  const clientId = await getEffectiveGoogleDriveClientId();
  if (!clientId) return null;

  try {
    const refreshed = await AuthSession.refreshAsync(
      {
        clientId,
        refreshToken: token.refreshToken,
        scopes: [GOOGLE_DRIVE_SCOPE],
      },
      discovery,
    );
    const next: GoogleDriveToken = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? token.refreshToken,
      expiresIn: refreshed.expiresIn,
      issuedAt: refreshed.issuedAt,
      tokenType: refreshed.tokenType,
    };
    await saveGoogleDriveToken(next);
    return next.accessToken;
  } catch {
    return null;
  }
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error("Google Drive is not connected or the login has expired.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(url, { ...init, headers });
}

async function getOrCreateBackupFolder(): Promise<string> {
  const cached = await SecureStore.getItemAsync(FOLDER_KEY);
  if (cached) {
    const check = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cached)}?fields=id,trashed`);
    if (check.ok) {
      const data = await check.json();
      if (data?.id && !data?.trashed) return cached;
    }
    await SecureStore.deleteItemAsync(FOLDER_KEY);
  }

  const q = encodeURIComponent(
    "name = 'Surgical Store Backups' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
  );
  const list = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)&pageSize=10`,
  );
  if (!list.ok) throw new Error(`Google Drive folder lookup failed (${list.status}).`);
  const data = await list.json();
  const existing = data?.files?.[0]?.id;
  if (existing) {
    await SecureStore.setItemAsync(FOLDER_KEY, existing);
    return existing;
  }

  const create = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Surgical Store Backups",
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  if (!create.ok) throw new Error(`Google Drive folder creation failed (${create.status}).`);
  const folder = await create.json();
  if (!folder?.id) throw new Error("Google Drive did not return a backup folder ID.");
  await SecureStore.setItemAsync(FOLDER_KEY, folder.id);
  return folder.id;
}

export async function uploadBackupToGoogleDrive(json: string, filename: string): Promise<string> {
  const folderId = await getOrCreateBackupFolder();
  const boundary = `surgical_store_${Date.now()}`;
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify({ name: filename, mimeType: "application/json", parents: [folderId] }) +
    `\r\n--${boundary}\r\n` +
    "Content-Type: application/json\r\n\r\n" +
    json +
    `\r\n--${boundary}--`;

  const res = await driveFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google Drive backup upload failed (${res.status})${detail ? `: ${detail.slice(0, 220)}` : ""}`);
  }
  const result = await res.json();
  if (!result?.id) throw new Error("Google Drive did not confirm the backup upload.");
  return result.id as string;
}

export async function listGoogleDriveBackups(): Promise<Array<{ id: string; name: string; createdTime?: string; size?: string }>> {
  const folderId = await getOrCreateBackupFolder();
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed = false and mimeType = 'application/json' and name contains '${BACKUP_NAME_PREFIX}'`,
  );
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime,size)&pageSize=20`,
  );
  if (!res.ok) throw new Error(`Google Drive backup list failed (${res.status}).`);
  const data = await res.json();
  return Array.isArray(data?.files) ? data.files : [];
}

export async function downloadGoogleDriveBackup(fileId: string): Promise<string> {
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google Drive backup download failed (${res.status})${detail ? `: ${detail.slice(0, 220)}` : ""}`);
  }
  return res.text();
}

export function getGoogleDriveDiscovery() {
  return discovery;
}
