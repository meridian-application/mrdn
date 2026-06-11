import type { PersistedState, SurveyAnswers, VKUserProfile } from "./types";

type BackendAuthResponse = {
  token?: string;
  state: PersistedState;
  error?: string;
};

type BackendSessionResponse = {
  state: PersistedState;
  error?: string;
};

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");
const SESSION_STORAGE_KEY = "meridian-api-session";

function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getStoredToken() {
  return getStorage()?.getItem(SESSION_STORAGE_KEY) || "";
}

function setStoredToken(token: string) {
  getStorage()?.setItem(SESSION_STORAGE_KEY, token);
}

function clearStoredToken() {
  getStorage()?.removeItem(SESSION_STORAGE_KEY);
}

function hasVKLaunchParams() {
  if (typeof window === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  return Boolean(params.get("sign") && params.get("vk_user_id"));
}

async function requestBackend<T>(
  path: string,
  options: RequestInit & { token?: string } = {}
): Promise<T> {
  const token = options.token ?? getStoredToken();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error || "Backend request failed.");
  }

  return payload;
}

export function isBackendConfigured() {
  return Boolean(API_BASE_URL);
}

export function hasBackendSession() {
  return isBackendConfigured() && Boolean(getStoredToken());
}

export async function loadBackendState(profile: VKUserProfile | null): Promise<PersistedState | null> {
  if (!isBackendConfigured()) {
    return null;
  }

  if (hasVKLaunchParams()) {
    const payload = await requestBackend<BackendAuthResponse>("/api/auth/vk", {
      method: "POST",
      body: JSON.stringify({
        launchParams: window.location.search.slice(1),
        profile,
      }),
      token: "",
    });

    if (payload.token) {
      setStoredToken(payload.token);
    }

    return payload.state;
  }

  const token = getStoredToken();

  if (!token) {
    return null;
  }

  try {
    const payload = await requestBackend<BackendSessionResponse>("/api/session", {
      method: "GET",
      token,
    });
    return payload.state;
  } catch {
    clearStoredToken();
    return null;
  }
}

export async function registerBackendUser(payload: {
  fullName: string;
  email: string;
  password: string;
  survey: SurveyAnswers;
  onboardingComplete: boolean;
}) {
  if (!isBackendConfigured()) {
    return null;
  }

  const response = await requestBackend<BackendAuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
    token: "",
  });

  if (response.token) {
    setStoredToken(response.token);
  }

  return response.state;
}

export async function loginBackendUser(email: string, password: string) {
  if (!isBackendConfigured()) {
    return null;
  }

  const response = await requestBackend<BackendAuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    token: "",
  });

  if (response.token) {
    setStoredToken(response.token);
  }

  return response.state;
}

export async function saveBackendState(state: PersistedState) {
  if (!hasBackendSession()) {
    return false;
  }

  await requestBackend<BackendSessionResponse>("/api/state", {
    method: "PUT",
    body: JSON.stringify({ state }),
  });
  return true;
}

export async function logoutBackend() {
  if (!isBackendConfigured()) {
    return;
  }

  const token = getStoredToken();
  clearStoredToken();

  if (!token) {
    return;
  }

  await requestBackend<{ ok: boolean }>("/api/logout", {
    method: "POST",
    token,
  }).catch(() => null);
}
