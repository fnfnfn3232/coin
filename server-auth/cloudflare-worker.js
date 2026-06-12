const COINNESS_NEWS_ENDPOINT = "https://api.coinness.com/feed/v1/breaking-news";
const COOKIE_NAME = "coin_board_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;

function jsonResponse(body, status = 200, env = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN || "",
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin",
    },
  });
}

function optionsResponse(env) {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN || "",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
  });
}

function textEncoder() {
  return new TextEncoder();
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder().encode(String(value || "")));
  return bytesToHex(digest);
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder().encode(value));
  return bytesToHex(signature);
}

function timingSafeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const cookies = header.split(";").map((item) => item.trim());
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

async function createSessionCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const nonce = crypto.randomUUID();
  const payload = `${exp}.${nonce}`;
  const signature = await hmacHex(env.SESSION_SECRET, payload);
  const token = `${payload}.${signature}`;
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

async function isAuthenticated(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expText, nonce, signature] = parts;
  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacHex(env.SESSION_SECRET, `${expText}.${nonce}`);
  return timingSafeEqual(signature, expected);
}

function cleanNewsText(value) {
  return String(value || "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function makePreview(value, maxChars = 140) {
  const text = cleanNewsText(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function parsePublishAt(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function normalizeNewsItem(entry, includeFullText) {
  const id = Number(entry?.id || 0);
  const publishAt = String(entry?.publishAt || "").trim();
  const publishAtTs = parsePublishAt(publishAt);
  const title = cleanNewsText(entry?.title);
  const content = cleanNewsText(entry?.content);
  if (!id || !publishAtTs || (!title && !content)) return null;

  const item = {
    id,
    publishAt,
    publishAtTs,
    headline: title || "Coinness news",
    summary: makePreview(content || title),
    sourceName: "Coinness",
    articleUrl: `https://coinness.com/news/${id}`,
    originUrl: entry?.link ? String(entry.link).trim() : "",
    originTitle: entry?.linkTitle ? String(entry.linkTitle).trim() : "",
  };
  if (includeFullText) {
    item.content = content;
  }
  return item;
}

let lastGoodNews = null;

async function fetchCoinnessNews(env) {
  const limit = Math.min(Math.max(Number(env.NEWS_LIMIT || 40), 1), 100);
  const includeFullText = String(env.NEWS_BODY_MODE || "preview").toLowerCase() === "full";
  const query = new URLSearchParams({ languageCode: "ko", limit: String(limit) });
  const response = await fetch(`${COINNESS_NEWS_ENDPOINT}?${query.toString()}`, {
    headers: {
      "Accept": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`coinness_fetch_failed:${response.status}`);
  }
  const payload = await response.json();
  const items = Array.isArray(payload)
    ? payload.map((entry) => normalizeNewsItem(entry, includeFullText)).filter(Boolean)
    : [];
  return {
    source: "coinness",
    mode: includeFullText ? "full" : "preview",
    fetchedAt: Math.floor(Date.now() / 1000),
    items,
  };
}

async function fetchCoinnessNewsSafely(env) {
  try {
    const news = await fetchCoinnessNews(env);
    if (news.items.length) {
      lastGoodNews = news;
    }
    return news;
  } catch (error) {
    if (lastGoodNews) {
      return {
        ...lastGoodNews,
        stale: true,
        error: "coinness_fetch_failed",
      };
    }
    return {
      source: "coinness",
      mode: String(env.NEWS_BODY_MODE || "preview").toLowerCase() === "full" ? "full" : "preview",
      fetchedAt: Math.floor(Date.now() / 1000),
      error: error instanceof Error ? error.message : "coinness_fetch_failed",
      items: [],
    };
  }
}

async function handleLogin(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch (_error) {
    return jsonResponse({ error: "invalid_json" }, 400, env);
  }
  const passwordHash = await sha256Hex(body.password || "");
  if (!timingSafeEqual(passwordHash, env.SITE_PASSWORD_SHA256)) {
    return jsonResponse({ error: "invalid_password" }, 401, env);
  }
  const headers = new Headers(jsonResponse({ ok: true }, 200, env).headers);
  headers.append("Set-Cookie", await createSessionCookie(env));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

function handleLogout(env) {
  const headers = new Headers(jsonResponse({ ok: true }, 200, env).headers);
  headers.append("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return optionsResponse(env);

    const url = new URL(request.url);
    if (!env.FRONTEND_ORIGIN || request.headers.get("Origin") !== env.FRONTEND_ORIGIN) {
      return jsonResponse({ error: "origin_not_allowed" }, 403, env);
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return handleLogout(env);
    }
    if (url.pathname === "/api/news" && request.method === "GET") {
      return jsonResponse(await fetchCoinnessNewsSafely(env), 200, env);
    }

    return jsonResponse({ error: "not_found" }, 404, env);
  },
};
