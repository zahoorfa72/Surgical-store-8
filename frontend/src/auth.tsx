// Auth context: persists the JWT, exposes the current user, and gates the app.
//
// Online-first, offline-capable:
//   - When the backend is reachable we log in normally and cache the account
//     (hashed password + user) in a local "vault" so it can be used again with
//     no connection.
//   - When the backend is NOT reachable (no server / no internet / the app was
//     built without a backend URL) we fall back to the vault so previously used
//     accounts — and the built-in demo accounts — can still sign in offline.
//   - Bootstrap keeps the last user signed in while offline instead of logging
//     them out the moment /auth/me can't be reached.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { storage } from "@/src/utils/storage";
import {
  ApiError,
  apiRequest,
  AppUser,
  getConnectionMode,
  loadBaseOverride,
  loginRequest,
  Role,
  setAuthToken,
} from "@/src/api";

const TOKEN_KEY = "ssm.token";
const USER_KEY = "ssm.user";
const VAULT_KEY = "ssm.vault";
const OFFLINE_TOKEN = "offline";

type VaultRecord = { hash: string; user: AppUser; token: string };
type Vault = Record<string, VaultRecord>;

// Built-in demo accounts so a fresh install with no server can still be used
// fully offline (these mirror the backend seed users shown on the login screen).
const DEMO_ACCOUNTS: Record<string, { password: string; user: AppUser }> = {
  "admin@store.com": {
    password: "Admin786",
    user: { id: "offline-admin", email: "admin@store.com", name: "Administrator", role: "admin", disabled: false },
  },
  "partner@store.com": {
    password: "partner123",
    user: { id: "offline-partner", email: "partner@store.com", name: "Store Partner", role: "partner", disabled: false },
  },
  "cashier@store.com": {
    password: "cashier123",
    user: { id: "offline-cashier", email: "cashier@store.com", name: "Front Cashier", role: "cashier", disabled: false },
  },
};

// Small deterministic hash so we never store the raw password on device.
// (SecureStore already encrypts at rest; this avoids keeping plaintext.)
function hashPassword(password: string): string {
  const salted = `ssm::v1::${password}`;
  let h = 5381;
  for (let i = 0; i < salted.length; i++) {
    h = ((h << 5) + h + salted.charCodeAt(i)) >>> 0;
  }
  return `h${h.toString(16)}`;
}

async function getVault(): Promise<Vault> {
  return ((await storage.getItem<Vault>(VAULT_KEY, {})) ?? {}) as Vault;
}

export async function saveOfflineCredentials(email: string, password: string, user: AppUser, token?: string) {
  const vault = await getVault();
  vault[email] = { hash: hashPassword(password), user, token: token ?? vault[email]?.token ?? OFFLINE_TOKEN };
  await storage.setItem(VAULT_KEY, vault as any);
}

// Create a usable account entirely on-device (used when there is no server).
// The account is a "cashier" by default and can sign in immediately offline.
export async function signupOffline(email: string, name: string, password: string): Promise<void> {
  const em = email.trim().toLowerCase();
  const vault = await getVault();
  if (vault[em] || DEMO_ACCOUNTS[em]) {
    throw new Error("An account with this email already exists on this device.");
  }
  const user: AppUser = {
    id: `local-user-${Date.now()}`,
    email: em,
    name: name.trim() || em,
    role: "cashier",
    disabled: false,
  };
  await saveOfflineCredentials(em, password, user, OFFLINE_TOKEN);
}

type AuthState = {
  user: AppUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  const bootstrap = useCallback(async () => {
    await loadBaseOverride();
    const token = await storage.getItem(TOKEN_KEY, "");
    if (!token) {
      setLoading(false);
      return;
    }
    setAuthToken(token === OFFLINE_TOKEN ? null : token);

    // Show the cached user immediately so the app is usable offline.
    const cached = await storage.getItem<AppUser | null>(USER_KEY, null);
    if (cached) setUser(cached);

    try {
      const me = await apiRequest<AppUser>("/auth/me");
      setUser(me);
      await storage.setItem(USER_KEY, me as any);
    } catch (e) {
      if (e instanceof ApiError) {
        // Server explicitly rejected the token -> genuinely signed out.
        setAuthToken(null);
        await storage.removeItem(TOKEN_KEY);
        await storage.removeItem(USER_KEY);
        setUser(null);
      }
      // Otherwise it's a network/offline error -> keep the cached user signed in.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  // Offline fallback: verify against the local vault or the demo accounts.
  const offlineLogin = useCallback(async (email: string, password: string): Promise<boolean> => {
    const vault = await getVault();
    let rec: VaultRecord | undefined = vault[email];

    if (!rec) {
      const demo = DEMO_ACCOUNTS[email];
      if (demo && demo.password === password) {
        rec = { hash: hashPassword(password), user: demo.user, token: OFFLINE_TOKEN };
      }
    }
    if (!rec || rec.hash !== hashPassword(password)) return false;

    setAuthToken(rec.token === OFFLINE_TOKEN ? null : rec.token);
    await storage.setItem(TOKEN_KEY, rec.token);
    await storage.setItem(USER_KEY, rec.user as any);
    setUser(rec.user);
    return true;
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const em = email.trim().toLowerCase();
    // In manual Offline mode never touch the server — sign in against the
    // on-device vault / demo accounts so login works with no connection.
    if ((await getConnectionMode()) === "offline") {
      const ok = await offlineLogin(em, password);
      if (!ok) {
        throw new Error(
          "Incorrect email or password. Offline sign-in works for the demo accounts or accounts created/used on this device.",
        );
      }
      return;
    }
    try {
      const res = await loginRequest(em, password);
      setAuthToken(res.access_token);
      await storage.setItem(TOKEN_KEY, res.access_token);
      await storage.setItem(USER_KEY, res.user as any);
      await saveOfflineCredentials(em, password, res.user, res.access_token);
      setUser(res.user);
    } catch (e) {
      // A wrong-password style rejection from a reachable server -> surface it,
      // but if the server can't actually verify (offline/500), fall back to the
      // on-device vault so the app stays usable.
      if (e instanceof ApiError && e.status === 401) throw e;
      const ok = await offlineLogin(em, password);
      if (!ok) {
        if (e instanceof ApiError) throw e;
        throw new Error(
          "Can't reach the server. Offline sign-in only works for accounts used online before on this device, or the demo accounts.",
        );
      }
    }
  }, [offlineLogin]);

  const logout = useCallback(async () => {
    setAuthToken(null);
    await storage.removeItem(TOKEN_KEY);
    await storage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await apiRequest<AppUser>("/auth/me");
      setUser(me);
      await storage.setItem(USER_KEY, me as any);
    } catch {
      /* offline or transient -> keep current user */
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, logout, refresh }),
    [user, loading, login, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

// Permission helpers
export function canManageStore(role?: Role): boolean {
  return role === "admin" || role === "partner";
}
export function isAdmin(role?: Role): boolean {
  return role === "admin";
}
