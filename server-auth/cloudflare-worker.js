const COINNESS_NEWS_ENDPOINT = "https://api.coinness.com/feed/v1/breaking-news";
const COOKIE_NAME = "coin_board_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const BOARD_POSTS_KEY = "free-board-posts";
const BOARD_MAX_POSTS = 200;
const BOARD_MAX_MEDIA = 4;

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
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
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

function cleanBoardText(value, maxChars) {
  return String(value || "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, maxChars);
}

function getSafeMediaKind(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    const path = url.pathname.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|avif)$/.test(path)) return "image";
    if (/\.(mp4|webm|ogv)$/.test(path)) return "video";
    return "";
  } catch (_error) {
    return "";
  }
}

function normalizeBoardPost(raw, fallback = {}) {
  const createdAt = Number(raw?.createdAt || fallback.createdAt || Date.now());
  const mediaUrls = Array.isArray(raw?.mediaUrls)
    ? raw.mediaUrls
        .map((url) => cleanBoardText(url, 1000))
        .filter((url, index, list) => getSafeMediaKind(url) && list.indexOf(url) === index)
        .slice(0, BOARD_MAX_MEDIA)
    : [];
  const title = cleanBoardText(raw?.title, 120);
  const body = cleanBoardText(raw?.body, 20000);
  if (!title || !body) return null;
  return {
    id: cleanBoardText(raw?.id || fallback.id || `post-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, 80),
    category: ["general", "info", "notice", "event"].includes(raw?.category) ? raw.category : "general",
    title,
    author: cleanBoardText(raw?.author || "익명", 40) || "익명",
    body,
    mediaUrls,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : undefined,
    views: Math.max(0, Math.floor(Number(raw?.views) || 0)),
    likes: Math.max(0, Math.floor(Number(raw?.likes) || 0)),
  };
}

async function readBoardPosts(env) {
  if (!env.BOARD_POSTS) {
    throw new Error("board_storage_not_configured");
  }
  const raw = await env.BOARD_POSTS.get(BOARD_POSTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((post) => normalizeBoardPost(post))
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, BOARD_MAX_POSTS);
  } catch (_error) {
    return [];
  }
}

async function writeBoardPosts(env, posts) {
  if (!env.BOARD_POSTS) {
    throw new Error("board_storage_not_configured");
  }
  const normalized = (Array.isArray(posts) ? posts : [])
    .map((post) => normalizeBoardPost(post))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, BOARD_MAX_POSTS);
  await env.BOARD_POSTS.put(BOARD_POSTS_KEY, JSON.stringify(normalized));
  return normalized;
}

async function requireAuth(request, env) {
  if (await isAuthenticated(request, env)) return null;
  return jsonResponse({ error: "auth_required" }, 401, env);
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch (_error) {
    return null;
  }
}

async function handleBoardPosts(request, env, url) {
  if (env.BOARD_STORE) {
    if (["POST", "PUT", "DELETE"].includes(request.method) && !url.pathname.endsWith("/view")) {
      const authResponse = await requireAuth(request, env);
      if (authResponse) return authResponse;
    }
    const id = env.BOARD_STORE.idFromName("free-board");
    return env.BOARD_STORE.get(id).fetch(request);
  }

  const postId = decodeURIComponent(url.pathname.replace(/^\/api\/board\/posts\/?/, ""));
  if (request.method === "GET" && url.pathname === "/api/board/posts") {
    return jsonResponse({ posts: await readBoardPosts(env) }, 200, env);
  }

  if (request.method === "POST" && url.pathname === "/api/board/posts") {
    const authResponse = await requireAuth(request, env);
    if (authResponse) return authResponse;
    const body = await parseJsonBody(request);
    const post = normalizeBoardPost(body, {
      id: `post-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: Date.now(),
    });
    if (!post) return jsonResponse({ error: "invalid_post" }, 400, env);
    const posts = (await readBoardPosts(env)).filter((item) => item.id !== post.id);
    posts.unshift(post);
    return jsonResponse({ posts: await writeBoardPosts(env, posts), post }, 201, env);
  }

  if (request.method === "POST" && postId && url.pathname.endsWith("/view")) {
    const id = postId.replace(/\/view$/, "");
    const posts = await readBoardPosts(env);
    const target = posts.find((post) => post.id === id);
    if (!target) return jsonResponse({ error: "not_found" }, 404, env);
    target.views = Math.max(0, Math.floor(Number(target.views) || 0)) + 1;
    await writeBoardPosts(env, posts);
    return jsonResponse({ posts, post: target }, 200, env);
  }

  if (request.method === "PUT" && postId) {
    const authResponse = await requireAuth(request, env);
    if (authResponse) return authResponse;
    const body = await parseJsonBody(request);
    const posts = await readBoardPosts(env);
    const index = posts.findIndex((post) => post.id === postId);
    if (index < 0) return jsonResponse({ error: "not_found" }, 404, env);
    const updated = normalizeBoardPost({
      ...posts[index],
      ...body,
      id: posts[index].id,
      createdAt: posts[index].createdAt,
      views: posts[index].views,
      likes: posts[index].likes,
      updatedAt: Date.now(),
    });
    if (!updated) return jsonResponse({ error: "invalid_post" }, 400, env);
    posts[index] = updated;
    return jsonResponse({ posts: await writeBoardPosts(env, posts), post: updated }, 200, env);
  }

  if (request.method === "DELETE" && postId) {
    const authResponse = await requireAuth(request, env);
    if (authResponse) return authResponse;
    const posts = await readBoardPosts(env);
    const nextPosts = posts.filter((post) => post.id !== postId);
    if (nextPosts.length === posts.length) return jsonResponse({ error: "not_found" }, 404, env);
    return jsonResponse({ posts: await writeBoardPosts(env, nextPosts), ok: true }, 200, env);
  }

  return jsonResponse({ error: "not_found" }, 404, env);
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

export class BoardStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async readPosts() {
    const stored = await this.state.storage.get(BOARD_POSTS_KEY);
    if (!Array.isArray(stored)) return [];
    return stored
      .map((post) => normalizeBoardPost(post))
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, BOARD_MAX_POSTS);
  }

  async writePosts(posts) {
    const normalized = (Array.isArray(posts) ? posts : [])
      .map((post) => normalizeBoardPost(post))
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, BOARD_MAX_POSTS);
    await this.state.storage.put(BOARD_POSTS_KEY, normalized);
    return normalized;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const postId = decodeURIComponent(url.pathname.replace(/^\/api\/board\/posts\/?/, ""));

    if (request.method === "GET" && url.pathname === "/api/board/posts") {
      return jsonResponse({ posts: await this.readPosts() }, 200, this.env);
    }

    if (request.method === "POST" && url.pathname === "/api/board/posts") {
      const body = await parseJsonBody(request);
      const post = normalizeBoardPost(body, {
        id: `post-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        createdAt: Date.now(),
      });
      if (!post) return jsonResponse({ error: "invalid_post" }, 400, this.env);
      const posts = (await this.readPosts()).filter((item) => item.id !== post.id);
      posts.unshift(post);
      return jsonResponse({ posts: await this.writePosts(posts), post }, 201, this.env);
    }

    if (request.method === "POST" && postId && url.pathname.endsWith("/view")) {
      const id = postId.replace(/\/view$/, "");
      const posts = await this.readPosts();
      const target = posts.find((post) => post.id === id);
      if (!target) return jsonResponse({ error: "not_found" }, 404, this.env);
      target.views = Math.max(0, Math.floor(Number(target.views) || 0)) + 1;
      await this.writePosts(posts);
      return jsonResponse({ posts, post: target }, 200, this.env);
    }

    if (request.method === "PUT" && postId) {
      const body = await parseJsonBody(request);
      const posts = await this.readPosts();
      const index = posts.findIndex((post) => post.id === postId);
      if (index < 0) return jsonResponse({ error: "not_found" }, 404, this.env);
      const updated = normalizeBoardPost({
        ...posts[index],
        ...body,
        id: posts[index].id,
        createdAt: posts[index].createdAt,
        views: posts[index].views,
        likes: posts[index].likes,
        updatedAt: Date.now(),
      });
      if (!updated) return jsonResponse({ error: "invalid_post" }, 400, this.env);
      posts[index] = updated;
      return jsonResponse({ posts: await this.writePosts(posts), post: updated }, 200, this.env);
    }

    if (request.method === "DELETE" && postId) {
      const posts = await this.readPosts();
      const nextPosts = posts.filter((post) => post.id !== postId);
      if (nextPosts.length === posts.length) return jsonResponse({ error: "not_found" }, 404, this.env);
      return jsonResponse({ posts: await this.writePosts(nextPosts), ok: true }, 200, this.env);
    }

    return jsonResponse({ error: "not_found" }, 404, this.env);
  }
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
    if (url.pathname === "/api/board/posts" || url.pathname.startsWith("/api/board/posts/")) {
      return handleBoardPosts(request, env, url);
    }

    return jsonResponse({ error: "not_found" }, 404, env);
  },
};
