import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createLocalBackend, createTauriBackend, isTauri, type Backend } from "@/data/backend";
import { createNexusStore, type NexusState, type NexusStore } from "./store";

let store: NexusStore | null = null;
let backendRef: Backend | null = null;

export async function bootstrapStore(): Promise<NexusStore> {
  if (store) return store;
  backendRef = isTauri()
    ? await createTauriBackend()
    : createLocalBackend(window.localStorage, {
        label: new URLSearchParams(location.search).get("window") === "overlay" ? "overlay" : "main",
        tickMs: 5000,
      });
  store = createNexusStore({ backend: backendRef });
  await store.getState().init();
  return store;
}

export function getStore(): NexusStore {
  if (!store) throw new Error("store not initialised");
  return store;
}

export function getBackend(): Backend {
  if (!backendRef) throw new Error("backend not initialised");
  return backendRef;
}

export function useNexus<T>(selector: (s: NexusState) => T): T {
  return useStore(getStore(), useShallow(selector));
}

export function nexus(): NexusState {
  return getStore().getState();
}
