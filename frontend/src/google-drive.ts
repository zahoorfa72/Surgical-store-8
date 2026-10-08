import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_KEY = "ssm.google-drive.token.v2";
const FOLDER_KEY = "ssm.google-drive.folder.v2";
const BACKUP_NAME_PREFIX = "SurgicalStore-";
const CLIENT_ID_KEY = "ssm.google-drive.client-id.v1";
const AUTO_BACKUP_FILE_KEY = "ssm.google-drive.auto-backup-file.v1";
const AUTO_BACKUP_FILE_NAME = "SurgicalStore-Auto-Backup.json";

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

export function isValidGoogleDriveClientId(clientId: string | null | undefined): boolean {
  return !!clientId && /^\d+-[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId.trim());
}

export function googleOAuthProjectNumber(clientId: string | null | undefined): string | null {
  const match = clientId?.trim().match(/^(\d+)-/);
  return match?.[1] ?? null;
}

export function areGoogleOAuthClientsInSameProject(
  androidClientId: string | null | undefined,
  webClientId: string | null | undefined,
): boolean {
  const androidProject = googleOAuthProjectNumber(androidClientId);
  const webProject = googleOAuthProjectNumber(webClientId);
  return !!androidProject && !!webProject && androidProject === webProject;
}

export function assertAndroidDriveOAuthClientsCompatible(webClientId: string): void {
  const androidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID?.trim() || null;
  if (!isValidGoogleDriveClientId(androidClientId)) {
    throw new Error("This Android build is missing its Google Android OAuth Client ID.");
  }
  if (!isValidGoogleDriveClientId(webClientId)) {
    throw new Error("Invalid Google Web Client ID.");
  }
  if (!areGoogleOAuthClientsInSameProject(androidClientId, webClientId)) {
    const androidProject = googleOAuthProjectNumber(androidClientId) ?? "unknown";
    const webProject = googleOAuthProjectNumber(webClientId) ?? "unknown";
    throw new Error(
      `Google OAuth project mismatch. Android client belongs to project ${androidProject}, but the Web client belongs to project ${webProject}. Create/use the Web client in the same Google Cloud project as the Android client.`,
    );
  }
}

export function googleDriveClientId(): string | null {
  const id =
    Platform.OS === "android"
      ? process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID
      : Platform.OS === "ios"
        ? process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
        : process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  return id?.trim() || null;
}

export function googleDriveWebClientId(): string | null {
  return process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim() || null;
}

async function getNativeGoogleSignIn() {
  if (Platform.OS !== "android") {
    throw new Error("Native Google Drive sign-in is only used on Android.");
  }
  return import("@react-native-google-signin/google-signin");
}

export async function connectGoogleDriveNative(webClientId: string): Promise<void> {
  if (Platform.OS !== "android") throw new Error("Native Google Drive sign-in is only available on Android.");
  if (!isValidGoogleDriveClientId(webClientId)) throw new Error("Invalid Google Web Client ID.");
  const { GoogleSignin } = await getNativeGoogleSignIn();
  GoogleSignin.configure({
    webClientId,
    scopes: [GOOGLE_DRIVE_SCOPE],
  });
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const response = await GoogleSignin.signIn();

  if (response.type !== "success") {
    throw new Error("Google Drive sign-in was cancelled.");
  }

  // Android separates account authentication from authorization for
  // additional Google API scopes. Explicitly request Drive access before
  // taking the access token used by the Drive REST API.
  try {
    await GoogleSignin.addScopes({ scopes: [GOOGLE_DRIVE_SCOPE] });
  } catch (error: any) {
    const message = String(error?.message ?? "");
    if (!/already|granted|authorized/i.test(message)) throw error;
  }

  const token = await GoogleSignin.getTokens();
  await saveGoogleDriveToken({
    accessToken: token.accessToken,
    issuedAt: Math.floor(Date.now() / 1000),
    expiresIn: 3600,
    tokenType: "Bearer",
  });
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
  // Android uses the native Google Sign-In SDK and never uses a browser
  // redirect here. This helper remains only for the existing iOS/web flow.
  const nativeRedirect =
    Platform.OS === "ios"
      ? "com.emergent.offlinesync.vbbelt:/oauthredirect"
      : undefined;
  return AuthSession.makeRedirectUri(nativeRedirect ? { native: nativeRedirect } : {});
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

  // Android uses Google's native SDK to refresh the access token. This avoids
  // the browser OAuth custom-URI redirect that can be rejected by Google.
  if (Platform.OS === "android") {
    const webClientId = googleDriveWebClientId() ?? (await getStoredGoogleDriveClientId());
    if (!webClientId) return token.accessToken ?? null;
    try {
      const { GoogleSignin } = await getNativeGoogleSignIn();
      GoogleSignin.configure({ webClientId, scopes: [GOOGLE_DRIVE_SCOPE] });
      const refreshed = await GoogleSignin.getTokens();
      const next: GoogleDriveToken = {
        accessToken: refreshed.accessToken,
        issuedAt: Math.floor(Date.now() / 1000),
        expiresIn: 3600,
        tokenType: "Bearer",
      };
      await saveGoogleDriveToken(next);
      return next.accessToken;
    } catch {
      return null;
    }
  }

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

const BACKUP_FOLDER_NAME = "Surgical Store Backups";

async function findExistingBackupFolder(): Promise<string | null> {
  try {
    const q = encodeURIComponent(`name = '${BACKUP_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const res = await driveFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime)&pageSize=20`,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.files) && data.files.length ? String(data.files[0]?.id ?? "") || null : null;
  } catch {
    return null;
  }
}

async function getOrCreateBackupFolder(): Promise<string> {
  const cached = await SecureStore.getItemAsync(FOLDER_KEY);
  if (cached) {
    try {
      const check = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cached)}?fields=id,name,mimeType,trashed`);
      if (check.ok) {
        const data = await check.json();
        if (data?.id && data?.mimeType === "application/vnd.google-apps.folder" && !data?.trashed) return cached;
      }
    } catch {}
    await SecureStore.deleteItemAsync(FOLDER_KEY);
  }

  // App data can be cleared while the Google Drive folder remains. Discover
  // the original app-created folder before creating another one, so backups
  // remain recoverable after reinstall / clear-data / fresh login.
  const discovered = await findExistingBackupFolder();
  if (discovered) {
    await SecureStore.setItemAsync(FOLDER_KEY, discovered);
    return discovered;
  }

  const create = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: BACKUP_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  if (!create.ok) {
    const detail = await create.text().catch(() => "");
    let message = "";
    try {
      const parsed = JSON.parse(detail);
      message = String(parsed?.error?.message ?? parsed?.error_description ?? "");
    } catch {
      message = detail;
    }
    throw new Error(
      `Google Drive folder creation failed (${create.status})${message ? `:${" " + message.slice(0, 300)}` : ""}`,
    );
  }
  const folder = await create.json();
  if (!folder?.id) throw new Error("Google Drive did not return a backup folder ID.");
  await SecureStore.setItemAsync(FOLDER_KEY, folder.id);
  return folder.id;
}

async function findAutoBackupFile(folderId: string): Promise<string | null> {
  const cached = await SecureStore.getItemAsync(AUTO_BACKUP_FILE_KEY);
  if (cached) {
    try {
      const check = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cached)}?fields=id,name,mimeType,trashed,parents`);
      if (check.ok) {
        const data = await check.json();
        if (data?.id && data?.name === AUTO_BACKUP_FILE_NAME && data?.mimeType === "application/json" && !data?.trashed) return String(data.id);
      }
    } catch {}
    await SecureStore.deleteItemAsync(AUTO_BACKUP_FILE_KEY);
  }

  const q = encodeURIComponent(`name = '${AUTO_BACKUP_FILE_NAME}' and mimeType = 'application/json' and trashed = false and '${folderId}' in parents`);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)&pageSize=10`);
  if (!res.ok) return null;
  const data = await res.json();
  const id = Array.isArray(data?.files) && data.files.length ? String(data.files[0]?.id ?? "") || null : null;
  if (id) await SecureStore.setItemAsync(AUTO_BACKUP_FILE_KEY, id);
  return id;
}

async function deleteOldBackupFiles(keepId: string): Promise<void> {
  try {
    const q = encodeURIComponent(`trashed = false and mimeType = 'application/json' and name contains '${BACKUP_NAME_PREFIX}'`);
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=100`);
    if (!res.ok) return;
    const data = await res.json();
    for (const file of Array.isArray(data?.files) ? data.files : []) {
      const id = String(file?.id ?? "");
      if (!id || id === keepId) continue;
      try {
        await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch {}
    }
  } catch {}
}

export async function uploadBackupToGoogleDrive(json: string, filename: string): Promise<string> {
  const folderId = await getOrCreateBackupFolder();
  const existingId = await findAutoBackupFile(folderId);
  const boundary = `surgical_store_${Date.now()}`;
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify({ name: AUTO_BACKUP_FILE_NAME, mimeType: "application/json" }) +
    `\r\n--${boundary}\r\n` +
    "Content-Type: application/json\r\n\r\n" +
    json +
    `\r\n--${boundary}--`;

  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id,name,webViewLink`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink";
  const res = await driveFetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google Drive backup upload failed (${res.status})${detail ? `: ${detail.slice(0, 220)}` : ""}`);
  }
  const result = await res.json();
  if (!result?.id) throw new Error("Google Drive did not confirm the backup upload.");
  await SecureStore.setItemAsync(AUTO_BACKUP_FILE_KEY, String(result.id));
  await deleteOldBackupFiles(String(result.id));
  return result.id as string;
}

export async function listGoogleDriveBackups(): Promise<Array<{ id: string; name: string; createdTime?: string; size?: string }>> {
  // Search all app-created Surgical Store backup files, not only the cached
  // folder ID. This is important after Android clear-data / reinstall because
  // SecureStore and the cached folder ID may be gone while Drive data remains.
  const q = encodeURIComponent(
    `trashed = false and mimeType = 'application/json' and name contains '${BACKUP_NAME_PREFIX}'`,
  );
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime desc&fields=files(id,name,createdTime,size,parents)&pageSize=100`,
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
