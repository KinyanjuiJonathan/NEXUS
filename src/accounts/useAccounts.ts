import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { defaultRecords } from "./backend";
import { createAccountsStore, type AccountsState } from "./store";

/** The one accounts store of this window. */
export const accountsStore = createAccountsStore(defaultRecords());

export function useAccounts<T>(selector: (s: AccountsState) => T): T {
  return useStore(accountsStore, useShallow(selector));
}

export const accounts = () => accountsStore.getState();
