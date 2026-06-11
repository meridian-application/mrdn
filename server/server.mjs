import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = resolve(rootDir, "server", "data");
const dbPath = process.env.MERIDIAN_DB_PATH || resolve(dataDir, "db.json");
const port = Number(process.env.PORT || 8787);
const vkAppSecret = process.env.VK_APP_SECRET || "";
const corsOrigin = process.env.CORS_ORIGIN || "*";

const defaultDb = {
  users: [],
  sessions: [],
};

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end(body);
}

function emptyResponse(res, status = 204) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  res.end();
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body.");
    error.status = 400;
    throw error;
  }
}

async function loadDb() {
  try {
    const raw = await readFile(dbPath, "utf8");
    const parsed = JSON.parse(raw);

    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return structuredClone(defaultDb);
  }
}

async function saveDb(db) {
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) {
    return false;
  }

  const { hash } = hashPassword(password, salt);
  const left = Buffer.from(hash, "hex");
  const right = Buffer.from(expectedHash, "hex");

  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readLaunchParamEntries(searchOrQuery) {
  const formattedSearch = String(searchOrQuery || "").startsWith("?")
    ? String(searchOrQuery).slice(1)
    : String(searchOrQuery || "");
  const queryParams = [];
  let sign = "";

  for (const param of formattedSearch.split("&")) {
    const separatorIndex = param.indexOf("=");
    const key = separatorIndex === -1 ? param : param.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? "" : param.slice(separatorIndex + 1);

    if (key === "sign") {
      sign = value;
    } else if (key.startsWith("vk_")) {
      queryParams.push({ key, value });
    }
  }

  return { queryParams, sign };
}

function signLaunchParams(searchOrQuery, secretKey) {
  const { queryParams } = readLaunchParamEntries(searchOrQuery);
  const queryString = queryParams
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ key, value }) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

  return crypto
    .createHmac("sha256", secretKey)
    .update(queryString)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=$/, "");
}

function verifyLaunchParams(searchOrQuery, secretKey) {
  if (!secretKey) {
    return null;
  }

  const formattedSearch = String(searchOrQuery || "").startsWith("?")
    ? String(searchOrQuery).slice(1)
    : String(searchOrQuery || "");
  const { queryParams, sign } = readLaunchParamEntries(formattedSearch);
  const vkUserId = queryParams.find((param) => param.key === "vk_user_id")?.value;
  const vkAppId = queryParams.find((param) => param.key === "vk_app_id")?.value;

  if (!sign || !vkUserId) {
    return null;
  }

  const expectedSign = signLaunchParams(formattedSearch, secretKey);

  if (expectedSign !== sign) {
    return null;
  }

  return {
    vkUserId,
    vkAppId: vkAppId || "",
  };
}

function toPublicUser(user) {
  return {
    id: user.id,
    vkId: user.vkId || undefined,
    fullName: user.fullName || "Пользователь",
    email: user.email || "",
    password: "",
    region: user.region || "Москва",
    createdAt: user.createdAt,
    survey: user.survey || {},
    onboardingComplete: Boolean(user.onboardingComplete),
    favorites: Array.isArray(user.favorites) ? user.favorites : [],
    metrics: Array.isArray(user.metrics) ? user.metrics : [],
  };
}

function stateForUser(user) {
  return {
    accounts: [toPublicUser(user)],
    currentUserId: user.id,
  };
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.sessions.push({
    token,
    userId,
    createdAt: new Date().toISOString(),
  });
  return token;
}

function readBearerToken(req) {
  const value = req.headers.authorization || "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function findSessionUser(db, req) {
  const token = readBearerToken(req);
  const session = db.sessions.find((item) => item.token === token);

  if (!session) {
    return { token, session: null, user: null };
  }

  const user = db.users.find((item) => item.id === session.userId) || null;
  return { token, session, user };
}

function buildNameFromProfile(profile, fallback) {
  const fullName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim();
  return fullName || fallback;
}

function createUserFromRegistration(body) {
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!email || !password || !String(body.fullName || "").trim()) {
    const error = new Error("Заполните имя, почту и пароль.");
    error.status = 400;
    throw error;
  }

  const { salt, hash } = hashPassword(password);

  return {
    id: crypto.randomUUID(),
    vkId: "",
    fullName: String(body.fullName).trim(),
    email,
    passwordSalt: salt,
    passwordHash: hash,
    region: "Москва",
    createdAt: new Date().toISOString(),
    survey: body.survey && typeof body.survey === "object" ? body.survey : {},
    onboardingComplete: Boolean(body.onboardingComplete),
    favorites: [],
    metrics: [],
  };
}

function applyStateToUser(user, state) {
  if (!state || !Array.isArray(state.accounts)) {
    return;
  }

  const incoming =
    state.accounts.find((account) => account.id === user.id) ||
    state.accounts.find((account) => account.id === state.currentUserId);

  if (!incoming || typeof incoming !== "object") {
    return;
  }

  user.fullName = String(incoming.fullName || user.fullName).trim() || user.fullName;
  user.region = String(incoming.region || user.region).trim() || user.region;
  user.survey = incoming.survey && typeof incoming.survey === "object" ? incoming.survey : user.survey;
  user.onboardingComplete = Boolean(incoming.onboardingComplete);
  user.favorites = Array.isArray(incoming.favorites) ? incoming.favorites : user.favorites;
  user.metrics = Array.isArray(incoming.metrics) ? incoming.metrics : user.metrics;
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    emptyResponse(res);
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      jsonResponse(res, 200, { ok: true });
      return;
    }

    const db = await loadDb();

    if (req.method === "POST" && url.pathname === "/api/auth/vk") {
      if (!vkAppSecret) {
        jsonResponse(res, 500, { error: "VK_APP_SECRET is not configured on backend." });
        return;
      }

      const body = await readJsonBody(req);
      const verified = verifyLaunchParams(body.launchParams, vkAppSecret);

      if (!verified) {
        jsonResponse(res, 401, { error: "Не удалось подтвердить пользователя VK." });
        return;
      }

      let user = db.users.find((item) => item.vkId === verified.vkUserId);
      const isNewUser = !user;

      if (!user) {
        user = {
          id: crypto.randomUUID(),
          vkId: verified.vkUserId,
          fullName: buildNameFromProfile(body.profile, `Пользователь VK ${verified.vkUserId}`),
          email: "",
          passwordSalt: "",
          passwordHash: "",
          region: "Москва",
          createdAt: new Date().toISOString(),
          survey: {},
          onboardingComplete: false,
          favorites: [],
          metrics: [],
        };
        db.users.push(user);
      } else if (body.profile) {
        user.fullName = user.fullName || buildNameFromProfile(body.profile, user.fullName);
      }

      const token = createSession(db, user.id);
      await saveDb(db);
      jsonResponse(res, 200, { token, state: stateForUser(user), user: toPublicUser(user), isNewUser });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const body = await readJsonBody(req);
      const user = createUserFromRegistration(body);

      if (db.users.some((item) => normalizeEmail(item.email) === user.email)) {
        jsonResponse(res, 409, { error: "Аккаунт с такой почтой уже существует." });
        return;
      }

      db.users.push(user);
      const token = createSession(db, user.id);
      await saveDb(db);
      jsonResponse(res, 200, { token, state: stateForUser(user), user: toPublicUser(user) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJsonBody(req);
      const email = normalizeEmail(body.email);
      const user = db.users.find((item) => normalizeEmail(item.email) === email);

      if (!user || !verifyPassword(body.password, user.passwordSalt, user.passwordHash)) {
        jsonResponse(res, 401, { error: "Неверная почта или пароль." });
        return;
      }

      const token = createSession(db, user.id);
      await saveDb(db);
      jsonResponse(res, 200, { token, state: stateForUser(user), user: toPublicUser(user) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      const { user } = findSessionUser(db, req);

      if (!user) {
        jsonResponse(res, 401, { error: "Сессия не найдена." });
        return;
      }

      jsonResponse(res, 200, { state: stateForUser(user), user: toPublicUser(user) });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/state") {
      const { user } = findSessionUser(db, req);

      if (!user) {
        jsonResponse(res, 401, { error: "Сессия не найдена." });
        return;
      }

      const body = await readJsonBody(req);
      applyStateToUser(user, body.state);
      await saveDb(db);
      jsonResponse(res, 200, { state: stateForUser(user), user: toPublicUser(user) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const token = readBearerToken(req);
      const nextDb = {
        ...db,
        sessions: db.sessions.filter((session) => session.token !== token),
      };
      await saveDb(nextDb);
      jsonResponse(res, 200, { ok: true });
      return;
    }

    jsonResponse(res, 404, { error: "Not found." });
  } catch (error) {
    jsonResponse(res, error.status || 500, {
      error: error.message || "Internal server error.",
    });
  }
}

createServer(handleRequest).listen(port, () => {
  console.log(`Meridian backend listening on http://localhost:${port}`);
});
