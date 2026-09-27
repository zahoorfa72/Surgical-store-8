import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_KEY = "ssm.google-drive.token.v1";
const FOLDER_KEY = "ssm.google-drive.folder.v1";

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

export async function saveGoogleDriveToken(token: GoogleDriveToken): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(token));
}

export async function clearGoogleDriveConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(FOLDER_KEY);
}

export async function hasGoogleDriveConnection(): Promise<boolean> {
  return !!(await SecureStore.getItemAsync(TOKEN_KEY));
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
  if (!token?.accessToken) return null;

  const issuedAt = Number(token.issuedAt ?? 0);
  const expiresIn = Number(token.expiresIn ?? 0);
  const freshUntil = issuedAt + Math.max(0, expiresIn - 300);
  const now = Math.floor(Date.now() / 1000);

  if (!expiresIn || now < freshUntil) return token.accessToken;
  if (!token.refreshToken) return null;

  const clientId = googleDriveClientId();
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
  if (!accessToken) throw new Error("Google Drive is not connected.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(url, { ...init, headers });
}

async function getOrCreateBackupFolder(): Promise<string> {
  const cached = await SecureStore.getItemAsync(FOLDER_KEY);
  if (cached) return cached;

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
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error("Google Drive is not connected.");

  const boundary = `surgical_store_${Date.now()}`;
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify({
      name: filename,
      mimeType: "application/json",
      parents: [folderId],
    }) +
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
    throw new Error(`Google Drive backup upload failed (${res.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`);
  }
  const result = await res.json();
  if (!result?.id) throw new Error("Google Drive did not confirm the backup upload.");
  return result.id as string;
}

export async function getGoogleDriveDiscovery() {
  return discovery;
}
