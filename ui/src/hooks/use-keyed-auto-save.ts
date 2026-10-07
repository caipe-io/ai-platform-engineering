"use client";

import { useCallback,useEffect,useRef,useState } from "react";

export type AutoSaveStatus = "idle" | "saving" | "saved" | "error";

export interface AutoSaveState {
  status: AutoSaveStatus;
  error?: string;
}

interface QueueEntry<Value> {
  appliedVersion: number;
  desiredValue: Value;
  desiredVersion: number;
  running: boolean;
}

interface UseKeyedAutoSaveOptions<Key extends string,Value> {
  persist: (key: Key,value: Value) => Promise<void>;
  onError?: (key: Key,value: Value,error: Error) => void;
  onSuccess?: (key: Key,value: Value) => void;
}

interface KeyedAutoSaveController<Key extends string,Value> {
  enqueue: (key: Key,value: Value) => void;
  pendingValueFor: (key: Key) => Value | undefined;
  retry: (key: Key) => void;
  stateFor: (key: Key) => AutoSaveState;
}

const IDLE_STATE: AutoSaveState = { status: "idle" };

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Unable to save this setting");
}

/**
 * Serializes writes independently per setting key.
 *
 * A user can continue interacting while a request is in flight. Intermediate
 * values are coalesced and the latest value is written next, which prevents an
 * older response from overwriting a newer choice.
 */
export function useKeyedAutoSave<Key extends string,Value>({
  persist,
  onError,
  onSuccess,
}: UseKeyedAutoSaveOptions<Key,Value>): KeyedAutoSaveController<Key,Value> {
  const [states,setStates] = useState<Partial<Record<Key,AutoSaveState>>>({});
  const queuesRef = useRef(new Map<Key,QueueEntry<Value>>());
  const mountedRef = useRef(true);
  const persistRef = useRef(persist);
  const onErrorRef = useRef(onError);
  const onSuccessRef = useRef(onSuccess);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    persistRef.current = persist;
    onErrorRef.current = onError;
    onSuccessRef.current = onSuccess;
  }, [onError,onSuccess,persist]);

  const updateState = useCallback((key: Key,state: AutoSaveState) => {
    if (!mountedRef.current) return;
    setStates((current) => ({ ...current,[key]: state }));
  }, []);

  const drain = useCallback(async (key: Key): Promise<void> => {
    const entry = queuesRef.current.get(key);
    if (!entry || entry.running) return;

    entry.running = true;
    while (entry.appliedVersion < entry.desiredVersion) {
      const version = entry.desiredVersion;
      const value = entry.desiredValue;
      updateState(key,{ status: "saving" });

      try {
        await persistRef.current(key,value);
        entry.appliedVersion = version;
        if (mountedRef.current) onSuccessRef.current?.(key,value);

        if (entry.appliedVersion === entry.desiredVersion) {
          updateState(key,{ status: "saved" });
        }
      } catch (reason) {
        const error = toError(reason);

        // A newer value makes this failed intermediate write obsolete. Continue
        // and persist the latest value instead of surfacing a stale failure.
        if (entry.desiredVersion > version) {
          entry.appliedVersion = version;
          continue;
        }

        updateState(key,{ status: "error",error: error.message });
        if (mountedRef.current) onErrorRef.current?.(key,value,error);
        entry.running = false;
        return;
      }
    }

    entry.running = false;
  }, [updateState]);

  const enqueue = useCallback((key: Key,value: Value) => {
    const current = queuesRef.current.get(key);
    if (current) {
      current.desiredValue = value;
      current.desiredVersion += 1;
    } else {
      queuesRef.current.set(key,{
        appliedVersion: 0,
        desiredValue: value,
        desiredVersion: 1,
        running: false,
      });
    }

    updateState(key,{ status: "saving" });
    void drain(key);
  }, [drain,updateState]);

  const retry = useCallback((key: Key) => {
    const entry = queuesRef.current.get(key);
    if (!entry) return;
    updateState(key,{ status: "saving" });
    void drain(key);
  }, [drain,updateState]);

  const pendingValueFor = useCallback((key: Key): Value | undefined => {
    return queuesRef.current.get(key)?.desiredValue;
  }, []);

  const stateFor = useCallback((key: Key): AutoSaveState => {
    return states[key] ?? IDLE_STATE;
  }, [states]);

  return { enqueue,pendingValueFor,retry,stateFor };
}
