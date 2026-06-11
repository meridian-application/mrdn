import type { PersistedState } from "./types";
import { getVKStorageValue, setVKStorageValue } from "./vk";

export const STORAGE_KEY = "meridian-vk-mini-state";

export const defaultState: PersistedState = {
  accounts: [],
  currentUserId: null,
};

let memoryState: PersistedState = defaultState;

function cloneState(state: PersistedState): PersistedState {
  return JSON.parse(JSON.stringify(state)) as PersistedState;
}

function getStorage() {
  try {
    const storage = window.localStorage;
    const probeKey = `${STORAGE_KEY}-probe`;
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

export function parsePersistedState(raw: string | null | undefined): PersistedState | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as PersistedState;

    if (!Array.isArray(parsed.accounts)) {
      return null;
    }

    if (parsed.currentUserId !== null && typeof parsed.currentUserId !== "string") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function loadState(): Promise<PersistedState> {
  try {
    // Try to load from VK Storage first
    const vkData = await getVKStorageValue(STORAGE_KEY);
    if (vkData) {
      const parsed = parsePersistedState(vkData);
      if (parsed) {
        memoryState = cloneState(parsed);
        // Also save to localStorage as backup
        const storage = getStorage();
        if (storage) {
          storage.setItem(STORAGE_KEY, vkData);
        }
        return parsed;
      }
    }

    // Fallback to localStorage
    const storage = getStorage();
    const localData = storage?.getItem(STORAGE_KEY);
    const parsed = parsePersistedState(localData);

    if (parsed) {
      memoryState = cloneState(parsed);
      return parsed;
    }

    return cloneState(memoryState);
  } catch {
    return cloneState(memoryState);
  }
}

export async function saveState(state: PersistedState) {
  memoryState = cloneState(state);
  const serialized = JSON.stringify(state);

  try {
    // Save to VK Storage
    await setVKStorageValue(STORAGE_KEY, serialized);
  } catch (vkError) {
    console.warn("Failed to save to VK Storage:", vkError);
  }

  try {
    // Also save to localStorage as backup
    const storage = getStorage();
    if (storage) {
      storage.setItem(STORAGE_KEY, serialized);
    }
  } catch {
    // Safari inside cross-origin iframes may block persistent storage.
    // In this case we keep working with an in-memory fallback.
  }
}
