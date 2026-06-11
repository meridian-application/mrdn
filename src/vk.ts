import type { VKUserProfile } from "./types";

type BridgeResponsePayload = {
  request_id?: string;
  error_type?: string;
  error_data?: unknown;
  [key: string]: unknown;
};

type PendingRequest = {
  resolve: (value: BridgeResponsePayload) => void;
  reject: (reason?: unknown) => void;
};

const CONNECT_VERSION = "2.15.11";

let initPromise: Promise<unknown> | null = null;
let requestCounter = 0;
let webFrameId: string | undefined;
const pendingRequests = new Map<string, PendingRequest>();

function nextRequestId() {
  requestCounter += 1;
  return `meridian_${requestCounter}_${Date.now()}`;
}

function isClient() {
  return typeof window !== "undefined";
}

function getAndroidBridge() {
  if (!isClient()) {
    return null;
  }

  return (window as Window & { AndroidBridge?: Record<string, unknown> }).AndroidBridge ?? null;
}

function getIosBridge() {
  if (!isClient()) {
    return null;
  }

  return (
    window as Window & {
      webkit?: {
        messageHandlers?: Record<string, { postMessage?: (params: unknown) => void }>;
      };
    }
  ).webkit?.messageHandlers ?? null;
}

function getWebBridge() {
  if (!isClient() || window.parent === window) {
    return null;
  }

  return typeof window.parent.postMessage === "function" ? window.parent : null;
}

function isEmbeddedRuntime() {
  return Boolean(getAndroidBridge() || getIosBridge() || getWebBridge());
}

function ensureListeners() {
  if (!isClient()) {
    return;
  }

  const handler = (rawEvent: Event | MessageEvent) => {
    const maybeMessageEvent = rawEvent as MessageEvent;
    const payload = maybeMessageEvent.data ?? (rawEvent as CustomEvent).detail;

    if (!payload || typeof payload !== "object") {
      return;
    }

    const eventPayload = payload as {
      type?: string;
      data?: BridgeResponsePayload;
      frameId?: string;
      detail?: {
        type?: string;
        data?: BridgeResponsePayload;
      };
    };

    const type = eventPayload.type ?? eventPayload.detail?.type;
    const data = eventPayload.data ?? eventPayload.detail?.data;
    const frameId = eventPayload.frameId;

    if (type === "VKWebAppSettings" && frameId) {
      webFrameId = frameId;
      return;
    }

    if (!data || typeof data !== "object") {
      return;
    }

    const requestId = data.request_id;

    if (!requestId) {
      return;
    }

    const pending = pendingRequests.get(requestId);

    if (!pending) {
      return;
    }

    pendingRequests.delete(requestId);

    if (data.error_type) {
      pending.reject(
        new Error(
          typeof data.error_data === "string"
            ? data.error_data
            : data.error_type
        )
      );
      return;
    }

    pending.resolve(data);
  };

  window.addEventListener("message", handler as EventListener);
  window.addEventListener("VKWebAppEvent", handler as EventListener);
}

let listenersInitialized = false;

function prepareBridge() {
  if (listenersInitialized || !isClient()) {
    return;
  }

  ensureListeners();
  listenersInitialized = true;
}

function postBridgeEvent(method: string, params: Record<string, unknown>) {
  const androidBridge = getAndroidBridge();

  if (androidBridge && typeof androidBridge[method] === "function") {
    androidBridge[method](JSON.stringify(params));
    return true;
  }

  const iosBridge = getIosBridge();

  if (
    iosBridge &&
    iosBridge[method] &&
    typeof iosBridge[method].postMessage === "function"
  ) {
    iosBridge[method].postMessage(params);
    return true;
  }

  const webBridge = getWebBridge();

  if (webBridge) {
    webBridge.postMessage(
      {
        handler: method,
        params,
        type: "vk-connect",
        webFrameId,
        connectVersion: CONNECT_VERSION,
      },
      "*"
    );
    return true;
  }

  return false;
}

function sendBridge(
  method: string,
  params: Record<string, unknown> = {}
): Promise<BridgeResponsePayload> {
  prepareBridge();

  if (!isEmbeddedRuntime()) {
    return Promise.reject(new Error("VK runtime is unavailable outside embedded mode."));
  }

  const requestId = nextRequestId();
  const payload = {
    ...params,
    request_id: requestId,
  };

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });

    const posted = postBridgeEvent(method, payload);

    if (!posted) {
      pendingRequests.delete(requestId);
      reject(new Error(`Unable to send ${method} through VK bridge.`));
      return;
    }

    window.setTimeout(() => {
      if (!pendingRequests.has(requestId)) {
        return;
      }

      pendingRequests.delete(requestId);

      if (method === "VKWebAppInit") {
        resolve({ request_id: requestId });
        return;
      }

      reject(new Error(`VK bridge timeout for ${method}.`));
    }, 4000);
  });
}

export function initializeVKBridge() {
  if (!initPromise) {
    if (!isEmbeddedRuntime()) {
      initPromise = Promise.resolve(null);
    } else {
      initPromise = sendBridge("VKWebAppInit").catch(() => null);
    }
  }

  return initPromise;
}

export async function initVKMiniApp(): Promise<VKUserProfile | null> {
  try {
    if (!isEmbeddedRuntime()) {
      return null;
    }

    await initializeVKBridge();
    const user = (await sendBridge("VKWebAppGetUserInfo")) as VKUserProfile;

    return {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      photo_200: user.photo_200,
    };
  } catch {
    return null;
  }
}


type VKStorageEntry = {
  key: string;
  value?: string;
};

type VKStorageGetResponse = BridgeResponsePayload & {
  keys?: VKStorageEntry[];
};

export async function getVKStorageValues(keys: string[]): Promise<Record<string, string>> {
  try {
    if (!isEmbeddedRuntime() || keys.length === 0) {
      return {};
    }

    await initializeVKBridge();
    const response = (await sendBridge("VKWebAppStorageGet", {
      keys,
    })) as VKStorageGetResponse;

    return Object.fromEntries(
      (response.keys ?? []).map((entry) => [entry.key, entry.value ?? ""])
    );
  } catch {
    return {};
  }
}

export async function getVKStorageValue(key: string): Promise<string | null> {
  const values = await getVKStorageValues([key]);
  return values[key] ?? null;
}

export async function setVKStorageValue(key: string, value: string): Promise<boolean> {
  try {
    if (!isEmbeddedRuntime()) {
      return false;
    }

    await initializeVKBridge();
    await sendBridge("VKWebAppStorageSet", { key, value });
    return true;
  } catch {
    return false;
  }
}
