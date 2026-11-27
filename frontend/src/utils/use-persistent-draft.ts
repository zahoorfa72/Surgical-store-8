import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AppState } from "react-native";

import { storage } from "@/src/utils/storage";

type StoredDraft<T> = { version: 1; updatedAt: number; value: T };
const MAX_DRAFT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Local-only form drafts survive Android background suspension and process recreation. */
export function usePersistentDraft<T>(
  key: string,
  initialValue: T,
): [T, Dispatch<SetStateAction<T>>, boolean, boolean, () => Promise<void>] {
  const [value, setValue] = useState<T>(initialValue);
  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState(false);
  const valueRef = useRef(value);
  const readyRef = useRef(false);
  const clearedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef<() => Promise<void>>(async () => {});
  valueRef.current = value;

  const setDraftValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    clearedRef.current = false;
    setValue((previous) => typeof next === "function"
      ? (next as (value: T) => T)(previous)
      : next);
  }, []);

  const saveNow = useCallback(async () => {
    if (!readyRef.current || clearedRef.current) return;
    await storage.setItem(key, {
      version: 1,
      updatedAt: Date.now(),
      value: valueRef.current,
    } satisfies StoredDraft<T>);
  }, [key]);
  saveRef.current = saveNow;

  useEffect(() => {
    let active = true;
    readyRef.current = false;
    clearedRef.current = false;
    setReady(false);
    setRestored(false);
    valueRef.current = initialValue;
    setValue(initialValue);
    void (async () => {
      const stored = await storage.getItem<StoredDraft<T> | null>(key, null);
      if (!active) return;
      const now = Date.now();
      const valid = !!stored && stored.version === 1 && stored.value !== undefined &&
        Number.isFinite(stored.updatedAt) && stored.updatedAt <= now + 60_000 &&
        now - stored.updatedAt <= MAX_DRAFT_AGE_MS;
      if (valid && stored) {
        valueRef.current = stored.value;
        setValue(stored.value);
        setRestored(true);
      } else if (stored) {
        await storage.removeItem(key);
      }
      if (active) {
        readyRef.current = true;
        setReady(true);
      }
    })().catch(() => {
      if (active) {
        readyRef.current = true;
        setReady(true);
      }
    });
    return () => { active = false; };
  }, [key, initialValue]);

  useEffect(() => {
    if (!ready || !readyRef.current || clearedRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void saveNow();
    }, 180);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [key, value, ready, saveNow]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        void saveRef.current();
      }
    });
    return () => subscription.remove();
  }, []);

  // Flush on navigation away too; a successful save calls clearDraft first.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (readyRef.current && !clearedRef.current) {
      void storage.setItem(key, {
        version: 1,
        updatedAt: Date.now(),
        value: valueRef.current,
      } satisfies StoredDraft<T>);
    }
  }, [key]);

  const clearDraft = useCallback(async () => {
    clearedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    await storage.removeItem(key);
  }, [key]);

  return [value, setDraftValue, ready, restored, clearDraft];
}

export function draftFieldSetter<T extends object, K extends keyof T>(
  setDraft: Dispatch<SetStateAction<T>>,
  field: K,
): Dispatch<SetStateAction<T[K]>> {
  return (next) => setDraft((current) => ({
    ...current,
    [field]: typeof next === "function"
      ? (next as (previous: T[K]) => T[K])(current[field])
      : next,
  }));
}
