import { createElement } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { initializeVKBridge } from "./vk";

const geologicaFontFaces = `
@font-face {
  font-family: "Geologica";
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url("/fonts/geologica-latin-400-normal.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: "Geologica";
  font-style: normal;
  font-display: swap;
  font-weight: 500;
  src: url("/fonts/geologica-latin-500-normal.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: "Geologica";
  font-style: normal;
  font-display: swap;
  font-weight: 600;
  src: url("/fonts/geologica-latin-600-normal.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: "Geologica";
  font-style: normal;
  font-display: swap;
  font-weight: 700;
  src: url("/fonts/geologica-latin-700-normal.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: "Geologica";
  font-style: normal;
  font-display: swap;
  font-weight: 800;
  src: url("/fonts/geologica-latin-800-normal.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: "Geologica";
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url("/fonts/geologica-cyrillic-400-normal.woff2") format("woff2");
  unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
@font-face {
  font-family: "Geologica";
  font-style: normal;
  font-display: swap;
  font-weight: 500;
  src: url("/fonts/geologica-cyrillic-500-normal.woff2") format("woff2");
  unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
@font-face {
  font-family: "Geologica";
  font-style: normal;
  font-display: swap;
  font-weight: 600;
  src: url("/fonts/geologica-cyrillic-600-normal.woff2") format("woff2");
  unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
@font-face {
  font-family: "Geologica";
  font-style: normal;
  font-display: swap;
  font-weight: 700;
  src: url("/fonts/geologica-cyrillic-700-normal.woff2") format("woff2");
  unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
@font-face {
  font-family: "Geologica";
  font-style: normal;
  font-display: swap;
  font-weight: 800;
  src: url("/fonts/geologica-cyrillic-800-normal.woff2") format("woff2");
  unicode-range: U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}`;

function injectGeologicaFonts() {
  const style = document.createElement("style");
  style.setAttribute("data-meridian-fonts", "geologica");
  style.textContent = geologicaFontFaces;
  document.head.appendChild(style);
}


function escapeHtml(value: string) {
  return value
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#39;");
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown startup error";
  }
}

function renderFatalScreen(error: unknown) {
  const root = document.getElementById("root");

  if (!root) {
    return;
  }

  const message = escapeHtml(normalizeError(error));

  root.innerHTML = `
    <div style="min-height:100vh;padding:24px;font-family:Geologica,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4fb;color:#18141f;display:flex;align-items:center;justify-content:center;">
      <div style="max-width:360px;width:100%;background:#fff;border:1px solid rgba(78,63,255,.12);border-radius:24px;padding:24px;box-shadow:0 24px 48px rgba(31,19,74,.12);">
        <div style="font-size:12px;letter-spacing:.14em;font-weight:700;color:#5d4dff;text-transform:uppercase;margin-bottom:12px;">Meridian Startup Error</div>
        <h1 style="margin:0 0 12px;font-size:28px;line-height:1.02;">Приложение не запустилось</h1>
        <p style="margin:0 0 14px;color:#655f75;line-height:1.5;">Скопируйте текст ниже и пришлите мне, я быстро исправлю точную причину.</p>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;background:#f3f1ff;border-radius:16px;padding:14px;font-size:13px;line-height:1.45;color:#30276b;">${message}</pre>
      </div>
    </div>
  `;
}

window.addEventListener("error", (event) => {
  renderFatalScreen(event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  renderFatalScreen(event.reason);
});

injectGeologicaFonts();

void initializeVKBridge().catch((error) => {
  renderFatalScreen(error);
});

try {
  ReactDOM.createRoot(document.getElementById("root")!).render(createElement(App));
} catch (error) {
  renderFatalScreen(error);
}
