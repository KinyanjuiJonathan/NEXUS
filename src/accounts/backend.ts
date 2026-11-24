import { invokeSafe, native } from "@/lib/platform";
import type { RecordKind } from "./types";

/**
 * Where the module's records are kept. In the desktop app that is the NEXUS
 * database (so the automatic backups cover them); in a browser preview it is
 * local storage. The rest of the module only sees this interface, which is
 * also the seam where a remote service would plug in for a taskers' side.
 */
export interface RecordStore {
  list<T>(kind: RecordKind): Promise<T[]>;
  put<T extends { id: string }>(kind: RecordKind, record: T): Promise<void>;
  remove(kind: RecordKind, id: string): Promise<void>;
}

const nativeStore: RecordStore = {
  list: (kind) => invokeSafe("records_list", { kind }),
  put: (kind, record) => invokeSafe("record_put", { kind, record }),
  remove: (kind, id) => invokeSafe("record_delete", { kind, id }),
};

/** Records in a key/value store (browser preview, tests). */
export function memoryRecords(kv: { getItem(k: string): string | null; setItem(k: string, v: string): void } = new Map<string, string>() as never): RecordStore {
  const map = kv instanceof Map ? { getItem: (k: string) => (kv as Map<string, string>).get(k) ?? null, setItem: (k: string, v: string) => void (kv as Map<string, string>).set(k, v) } : kv;
  const key = (kind: string) => `nexus.accounts.${kind}`;
  const read = <T,>(kind: string): T[] => JSON.parse(map.getItem(key(kind)) ?? "[]") as T[];
  return {
    list: async (kind) => read(kind),
    put: async (kind, record) => {
      const all = read<{ id: string }>(kind).filter((r) => r.id !== record.id);
      map.setItem(key(kind), JSON.stringify([...all, record]));
    },
    remove: async (kind, id) => map.setItem(key(kind), JSON.stringify(read<{ id: string }>(kind).filter((r) => r.id !== id))),
  };
}

export function defaultRecords(): RecordStore {
  if (native) return nativeStore;
  try {
    return memoryRecords(window.localStorage);
  } catch {
    return memoryRecords();
  }
}
