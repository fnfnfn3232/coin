const COINNESS_NEWS_ENDPOINT = "https://api.coinness.com/feed/v1/breaking-news";
const COOKIE_NAME = "coin_board_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const BOARD_POSTS_KEY = "free-board-posts";
const USAGE_STATS_KEY = "usage-stats-v1";
const BOARD_MAX_POSTS = 200;
const BOARD_MAX_MEDIA = 10;
const BOARD_MAX_COMMENTS = 100;
const GITHUB_PAGES_MONTHLY_SOFT_LIMIT_BYTES = 100 * 1024 * 1024 * 1024;
const USAGE_BEACON_MAX_BYTES = 25 * 1024 * 1024;

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
    if (getYouTubeEmbedUrl(url)) return "video";
    const path = url.pathname.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|avif)$/.test(path)) return "image";
    if (/\.(mp4|webm|ogv)$/.test(path)) return "video";
    return "";
  } catch (_error) {
    return "";
  }
}

function getYouTubeEmbedUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(String(value || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    if (url.username || url.password) return "";
    const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    let videoId = "";
    if (host === "youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] || "";
    } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/watch") {
        videoId = url.searchParams.get("v") || "";
      } else if (parts[0] === "shorts" || parts[0] === "embed") {
        videoId = parts[1] || "";
      }
    }
    return /^[A-Za-z0-9_-]{11}$/.test(videoId) ? `https://www.youtube-nocookie.com/embed/${videoId}` : "";
  } catch (_error) {
    return "";
  }
}

function normalizePasswordHash(value) {
  const hash = cleanBoardText(value, 128);
  return /^[a-f0-9]{64}$/i.test(hash) ? hash.toLowerCase() : "";
}

function normalizeBoardComment(raw, fallback = {}) {
  const createdAt = Number(raw?.createdAt || fallback.createdAt || Date.now());
  const body = cleanBoardText(raw?.body, 3000);
  if (!body) return null;
  return {
    id: cleanBoardText(raw?.id || fallback.id || `comment-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, 80),
    author: cleanBoardText(raw?.author || "익명", 40) || "익명",
    body,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    passwordHash: normalizePasswordHash(raw?.passwordHash),
  };
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
  const comments = Array.isArray(raw?.comments)
    ? raw.comments
        .map((comment) => normalizeBoardComment(comment))
        .filter(Boolean)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, BOARD_MAX_COMMENTS)
    : [];
  return {
    id: cleanBoardText(raw?.id || fallback.id || `post-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, 80),
    category: ["general", "info", "notice", "event"].includes(raw?.category) ? raw.category : "general",
    title,
    author: cleanBoardText(raw?.author || "익명", 40) || "익명",
    body,
    htmlEnabled: Boolean(raw?.htmlEnabled),
    mediaUrls,
    comments,
    passwordHash: normalizePasswordHash(raw?.passwordHash),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : undefined,
    views: Math.max(0, Math.floor(Number(raw?.views) || 0)),
    likes: Math.max(0, Math.floor(Number(raw?.likes) || 0)),
  };
}

function getKstDateKey(now = Date.now()) {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getKstMonthKey(now = Date.now()) {
  return getKstDateKey(now).slice(0, 7);
}

function normalizeUsageStats(raw) {
  return {
    months: raw && typeof raw.months === "object" && raw.months ? raw.months : {},
    days: raw && typeof raw.days === "object" && raw.days ? raw.days : {},
    totalViews: Math.max(0, Math.floor(Number(raw?.totalViews) || 0)),
    totalBytes: Math.max(0, Math.floor(Number(raw?.totalBytes) || 0)),
    firstSeen: Math.max(0, Math.floor(Number(raw?.firstSeen) || 0)),
    lastSeen: Math.max(0, Math.floor(Number(raw?.lastSeen) || 0)),
  };
}

function normalizeUsageBucket(bucket) {
  return {
    views: Math.max(0, Math.floor(Number(bucket?.views) || 0)),
    bytes: Math.max(0, Math.floor(Number(bucket?.bytes) || 0)),
    samples: Math.max(0, Math.floor(Number(bucket?.samples) || 0)),
    lastSeen: Math.max(0, Math.floor(Number(bucket?.lastSeen) || 0)),
  };
}

function publicUsageStats(raw) {
  const stats = normalizeUsageStats(raw);
  const monthKey = getKstMonthKey();
  const dayKey = getKstDateKey();
  const month = normalizeUsageBucket(stats.months[monthKey]);
  const day = normalizeUsageBucket(stats.days[dayKey]);
  return {
    monthKey,
    dayKey,
    monthlySoftLimitBytes: GITHUB_PAGES_MONTHLY_SOFT_LIMIT_BYTES,
    month,
    today: day,
    totalViews: stats.totalViews,
    totalBytes: stats.totalBytes,
    firstSeen: stats.firstSeen,
    lastSeen: stats.lastSeen,
    note: "브라우저 Performance API 기반 추정치입니다. GitHub Pages 공식 청구/집계값은 아닙니다.",
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

async function isValidPassword(password, env) {
  const passwordHash = await sha256Hex(password || "");
  return timingSafeEqual(passwordHash, env.SITE_PASSWORD_SHA256);
}

async function isAdminPassword(password, env) {
  return isValidPassword(password, env);
}

async function isMatchingPassword(password, storedHash) {
  const hash = normalizePasswordHash(storedHash);
  if (!hash) return false;
  const passwordHash = await sha256Hex(password || "");
  return timingSafeEqual(passwordHash, hash);
}

async function requireAuthOrPassword(request, env, body = null) {
  if (await isAuthenticated(request, env)) return null;
  if (body && await isValidPassword(body.password, env)) return null;
  return jsonResponse({ error: "auth_required" }, 401, env);
}

function withoutPassword(body) {
  if (!body || typeof body !== "object") return {};
  const {
    password: _password,
    adminPassword: _adminPassword,
    postPassword: _postPassword,
    newPostPassword: _newPostPassword,
    commentPassword: _commentPassword,
    ...rest
  } = body;
  return rest;
}

function publicBoardComment(comment) {
  const normalized = normalizeBoardComment(comment);
  if (!normalized) return null;
  const { passwordHash: _passwordHash, ...safeComment } = normalized;
  return safeComment;
}

function publicBoardPost(post) {
  const normalized = normalizeBoardPost(post);
  if (!normalized) return null;
  const { passwordHash: _passwordHash, comments, ...safePost } = normalized;
  safePost.comments = (comments || []).map(publicBoardComment).filter(Boolean);
  safePost.commentCount = safePost.comments.length;
  return safePost;
}

function publicBoardPosts(posts) {
  return (Array.isArray(posts) ? posts : [])
    .map(publicBoardPost)
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, BOARD_MAX_POSTS);
}

function boardJsonResponse(posts, status, env, extra = {}) {
  const safePosts = publicBoardPosts(posts);
  const body = { posts: safePosts, ...extra };
  if (extra.post) body.post = publicBoardPost(extra.post);
  if (extra.comment) body.comment = publicBoardComment(extra.comment);
  return jsonResponse(body, status, env);
}

async function canManagePost(post, body, env) {
  if (await isAdminPassword(body?.adminPassword || "", env)) return true;
  return isMatchingPassword(body?.postPassword || body?.password || "", post?.passwordHash || "");
}

async function canManageComment(comment, body, env) {
  if (await isAdminPassword(body?.adminPassword || "", env)) return true;
  return isMatchingPassword(body?.commentPassword || body?.password || "", comment?.passwordHash || "");
}

function jsonRequestWithoutPassword(request, body) {
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(withoutPassword(body)),
  });
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
    const id = env.BOARD_STORE.idFromName("free-board");
    return env.BOARD_STORE.get(id).fetch(request);
  }

  const postId = decodeURIComponent(url.pathname.replace(/^\/api\/board\/posts\/?/, ""));
  if (request.method === "GET" && url.pathname === "/api/board/posts") {
    return jsonResponse({ posts: await readBoardPosts(env) }, 200, env);
  }

  if (request.method === "POST" && url.pathname === "/api/board/posts") {
    const body = await parseJsonBody(request);
    const authResponse = await requireAuthOrPassword(request, env, body);
    if (authResponse) return authResponse;
    const post = normalizeBoardPost(withoutPassword(body), {
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
    const body = await parseJsonBody(request);
    const authResponse = await requireAuthOrPassword(request, env, body);
    if (authResponse) return authResponse;
    const posts = await readBoardPosts(env);
    const index = posts.findIndex((post) => post.id === postId);
    if (index < 0) return jsonResponse({ error: "not_found" }, 404, env);
    const updated = normalizeBoardPost({
      ...posts[index],
      ...withoutPassword(body),
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
    const body = await parseJsonBody(request.clone());
    const authResponse = await requireAuthOrPassword(request, env, body);
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

  async readUsageStats() {
    return normalizeUsageStats(await this.state.storage.get(USAGE_STATS_KEY));
  }

  async writeUsageStats(stats) {
    const normalized = normalizeUsageStats(stats);
    await this.state.storage.put(USAGE_STATS_KEY, normalized);
    return normalized;
  }

  async recordUsageBeacon(body) {
    const rawBytes = Math.max(0, Math.floor(Number(body?.bytes) || 0));
    const bytes = Math.min(rawBytes, USAGE_BEACON_MAX_BYTES);
    const now = Date.now();
    const monthKey = getKstMonthKey(now);
    const dayKey = getKstDateKey(now);
    const stats = await this.readUsageStats();
    stats.months[monthKey] = normalizeUsageBucket(stats.months[monthKey]);
    stats.days[dayKey] = normalizeUsageBucket(stats.days[dayKey]);
    stats.months[monthKey].views += 1;
    stats.months[monthKey].samples += bytes > 0 ? 1 : 0;
    stats.months[monthKey].bytes += bytes;
    stats.months[monthKey].lastSeen = now;
    stats.days[dayKey].views += 1;
    stats.days[dayKey].samples += bytes > 0 ? 1 : 0;
    stats.days[dayKey].bytes += bytes;
    stats.days[dayKey].lastSeen = now;
    stats.totalViews += 1;
    stats.totalBytes += bytes;
    stats.firstSeen = stats.firstSeen || now;
    stats.lastSeen = now;

    const monthKeep = new Set();
    for (let offset = 0; offset < 18; offset += 1) {
      const date = new Date(now + 9 * 60 * 60 * 1000);
      date.setUTCMonth(date.getUTCMonth() - offset);
      monthKeep.add(date.toISOString().slice(0, 7));
    }
    Object.keys(stats.months).forEach((key) => {
      if (!monthKeep.has(key)) delete stats.months[key];
    });
    const dayKeep = new Set();
    for (let offset = 0; offset < 120; offset += 1) {
      const date = new Date(now + 9 * 60 * 60 * 1000);
      date.setUTCDate(date.getUTCDate() - offset);
      dayKeep.add(date.toISOString().slice(0, 10));
    }
    Object.keys(stats.days).forEach((key) => {
      if (!dayKeep.has(key)) delete stats.days[key];
    });

    return this.writeUsageStats(stats);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const postId = decodeURIComponent(url.pathname.replace(/^\/api\/board\/posts\/?/, ""));

    if (request.method === "POST" && url.pathname === "/api/usage/beacon") {
      const body = await parseJsonBody(request);
      const stats = await this.recordUsageBeacon(body);
      return jsonResponse({ ok: true, usage: publicUsageStats(stats) }, 200, this.env);
    }

    if (request.method === "POST" && url.pathname === "/api/usage/stats") {
      const body = await parseJsonBody(request);
      if (!await isAdminPassword(body?.adminPassword || body?.password || "", this.env)) {
        return jsonResponse({ error: "invalid_password" }, 401, this.env);
      }
      return jsonResponse({ usage: publicUsageStats(await this.readUsageStats()) }, 200, this.env);
    }

    if (request.method === "GET" && url.pathname === "/api/board/posts") {
      return boardJsonResponse(await this.readPosts(), 200, this.env);
    }

    if (request.method === "POST" && url.pathname === "/api/board/posts") {
      const body = await parseJsonBody(request);
      const postPassword = cleanBoardText(body?.postPassword, 200);
      if (!postPassword) return jsonResponse({ error: "post_password_required" }, 400, this.env);
      const post = normalizeBoardPost(body, {
        id: `post-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        createdAt: Date.now(),
      });
      if (!post) return jsonResponse({ error: "invalid_post" }, 400, this.env);
      post.passwordHash = await sha256Hex(postPassword);
      const posts = (await this.readPosts()).filter((item) => item.id !== post.id);
      posts.unshift(post);
      return boardJsonResponse(await this.writePosts(posts), 201, this.env, { post });
    }

    if (request.method === "POST" && postId && url.pathname.endsWith("/view")) {
      const id = postId.replace(/\/view$/, "");
      const posts = await this.readPosts();
      const target = posts.find((post) => post.id === id);
      if (!target) return jsonResponse({ error: "not_found" }, 404, this.env);
      target.views = Math.max(0, Math.floor(Number(target.views) || 0)) + 1;
      await this.writePosts(posts);
      return boardJsonResponse(posts, 200, this.env, { post: target });
    }

    if (request.method === "POST" && /^\/api\/board\/posts\/[^/]+\/comments$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[4] || "");
      const body = await parseJsonBody(request);
      const commentPassword = cleanBoardText(body?.commentPassword, 200);
      if (!commentPassword) return jsonResponse({ error: "comment_password_required" }, 400, this.env);
      const posts = await this.readPosts();
      const target = posts.find((post) => post.id === id);
      if (!target) return jsonResponse({ error: "not_found" }, 404, this.env);
      const comment = normalizeBoardComment(body, {
        id: `comment-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        createdAt: Date.now(),
      });
      if (!comment) return jsonResponse({ error: "invalid_comment" }, 400, this.env);
      comment.passwordHash = await sha256Hex(commentPassword);
      target.comments = Array.isArray(target.comments) ? target.comments : [];
      target.comments.push(comment);
      target.comments = target.comments.slice(-BOARD_MAX_COMMENTS);
      target.updatedAt = Date.now();
      return boardJsonResponse(await this.writePosts(posts), 201, this.env, { post: target, comment });
    }

    if (request.method === "DELETE" && /^\/api\/board\/posts\/[^/]+\/comments\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const id = decodeURIComponent(parts[4] || "");
      const commentId = decodeURIComponent(parts[6] || "");
      const body = await parseJsonBody(request);
      const posts = await this.readPosts();
      const target = posts.find((post) => post.id === id);
      if (!target) return jsonResponse({ error: "not_found" }, 404, this.env);
      const comments = Array.isArray(target.comments) ? target.comments : [];
      const comment = comments.find((item) => item.id === commentId);
      if (!comment) return jsonResponse({ error: "not_found" }, 404, this.env);
      if (!await canManageComment(comment, body, this.env)) {
        return jsonResponse({ error: "invalid_password" }, 401, this.env);
      }
      target.comments = comments.filter((item) => item.id !== commentId);
      target.updatedAt = Date.now();
      return boardJsonResponse(await this.writePosts(posts), 200, this.env, { post: target, ok: true });
    }

    if (request.method === "PUT" && postId) {
      const body = await parseJsonBody(request);
      const posts = await this.readPosts();
      const index = posts.findIndex((post) => post.id === postId);
      if (index < 0) return jsonResponse({ error: "not_found" }, 404, this.env);
      if (!await canManagePost(posts[index], body, this.env)) {
        return jsonResponse({ error: "invalid_password" }, 401, this.env);
      }
      const updated = normalizeBoardPost({
        ...posts[index],
        ...withoutPassword(body),
        id: posts[index].id,
        createdAt: posts[index].createdAt,
        views: posts[index].views,
        likes: posts[index].likes,
        comments: posts[index].comments,
        passwordHash: cleanBoardText(body?.newPostPassword, 200)
          ? await sha256Hex(body.newPostPassword)
          : posts[index].passwordHash,
        updatedAt: Date.now(),
      });
      if (!updated) return jsonResponse({ error: "invalid_post" }, 400, this.env);
      posts[index] = updated;
      return boardJsonResponse(await this.writePosts(posts), 200, this.env, { post: updated });
    }

    if (request.method === "DELETE" && postId) {
      const body = await parseJsonBody(request);
      const posts = await this.readPosts();
      const target = posts.find((post) => post.id === postId);
      if (!target) return jsonResponse({ error: "not_found" }, 404, this.env);
      if (!await canManagePost(target, body, this.env)) {
        return jsonResponse({ error: "invalid_password" }, 401, this.env);
      }
      const nextPosts = posts.filter((post) => post.id !== postId);
      return boardJsonResponse(await this.writePosts(nextPosts), 200, this.env, { ok: true });
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
    if (url.pathname === "/api/usage/beacon" || url.pathname === "/api/usage/stats") {
      if (!env.BOARD_STORE) return jsonResponse({ error: "usage_storage_not_configured" }, 500, env);
      const id = env.BOARD_STORE.idFromName("free-board");
      return env.BOARD_STORE.get(id).fetch(request);
    }
    if (url.pathname === "/api/board/posts" || url.pathname.startsWith("/api/board/posts/")) {
      return handleBoardPosts(request, env, url);
    }

    return jsonResponse({ error: "not_found" }, 404, env);
  },
};
