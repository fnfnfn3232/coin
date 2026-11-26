import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decryptBackup, restoreBackup } from "./restore-backup.mjs";

const source = await readFile(new URL("./cloudflare-worker.js", import.meta.url), "utf8");
const { BoardStore, encryptBackupJson, encryptBackupFrames, syncBoardMediaToBackup } = await import(
  "data:text/javascript;base64," + Buffer.from(source + "\nexport { encryptBackupJson, encryptBackupFrames, syncBoardMediaToBackup };\n//# sourceURL=backup-worker-under-test.mjs").toString("base64"));
const secret = "synthetic-backup-test-secret-not-for-production";
async function* chunks(bytes, size = 997) {
  for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size);
}
async function collect(iterator) {
  const values = [];
  for await (const value of iterator) values.push(value);
  return Buffer.concat(values);
}
async function* strings(values) { yield* values; }
const decode = async bytes => JSON.parse((await collect(decryptBackup(chunks(bytes), secret))).toString("utf8"));

function fixture(records = new Map()) {
  const lists = [], gets = [], stored = new Map(), uploads = [];
  const storage = {
    async get(key, options) { gets.push({ key, options }); return structuredClone(records.get(key)); },
    async list(options) {
      lists.push(options);
      return new Map([...records].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .filter(([key]) => key.startsWith(options.prefix) && (!options.startAfter || key > options.startAfter))
        .slice(0, options.limit).map(([key, value]) => [key, structuredClone(value)]));
    },
  };
  const bucket = {
    async head(key) {
      return stored.has(key) ? { size: stored.get(key).length,
        customMetadata: uploads.find(upload => upload.key === key)?.options.customMetadata || {} } : null;
    },
    async list() { return { objects: [], truncated: false }; },
    async createMultipartUpload(key, options) {
      const uploaded = [], upload = { key, options, uploaded, completeCalls: 0, aborted: false };
      uploads.push(upload);
      return {
        async uploadPart(partNumber, bytes) {
          if (upload.failPart === partNumber) throw new Error("synthetic_upload_failure");
          uploaded.push(Buffer.from(bytes));
          return { partNumber, etag: "test-" + partNumber };
        },
        async complete(parts) {
          assert.equal(parts.length, uploaded.length);
          upload.completeCalls++;
          stored.set(key, Buffer.concat(uploaded));
        },
        async abort() { upload.aborted = true; },
      };
    },
    async put(key, bytes) { stored.set(key, Buffer.from(bytes)); },
  };
  const store = new BoardStore({ storage }, { SESSION_SECRET: secret, BACKUP_BUCKET: bucket });
  const sections = { members: [{ id: "private-member" }], posts: [{ title: "private-post" }], categories: [], screenSettings: {},
    adminLogs: [], usageStats: {}, news: { items: [] }, marketData: { boards: {} }, exchangeHistory: {} };
  for (const [method, name] of Object.entries({ readMembers: "members", readPosts: "posts", readCategories: "categories",
    readScreenSettingsRecord: "screenSettings", readAdminLogs: "adminLogs", readUsageStats: "usageStats", readNewsStore: "news",
    readMarketData: "marketData", readExchangeHistory: "exchangeHistory" })) store[method] = async () => structuredClone(sections[name]);
  return { store, records, lists, gets, stored, uploads, bucket, sections };
}

test("old CBK1 and framed CBK2 decrypt to the same JSON including split surrogate pairs", async () => {
  const value = { text: "x".repeat(21844) + "\ud83d\ude80\ud55c\uae00".repeat(20000) };
  const json = JSON.stringify(value);
  assert.deepEqual(await decode(await encryptBackupJson(value, { SESSION_SECRET: secret })), value);
  const bytes = await collect(encryptBackupFrames(strings([json.slice(0, 100), json.slice(100)]), { SESSION_SECRET: secret }));
  assert.deepEqual(await decode(bytes), value);
  assert.equal(bytes[3], 2);
});

test("framed backups reject truncation, tampering, wrong keys, reordered and cross-file frames", async () => {
  const encode = () => collect(encryptBackupFrames(strings([JSON.stringify({ body: "x".repeat(180000) })]), { SESSION_SECRET: secret }));
  const bytes = await encode(), other = await encode();
  const frameEnd = 20 + 17 + bytes.readUInt32BE(21);
  const nextEnd = frameEnd + 17 + bytes.readUInt32BE(frameEnd + 1);
  const tampered = Buffer.from(bytes); tampered[50] ^= 1;
  const invalid = [bytes.subarray(0, -1), bytes.subarray(0, -33), tampered, Buffer.concat([bytes, Buffer.from([0])]),
    Buffer.concat([bytes.subarray(0, 20), bytes.subarray(frameEnd, nextEnd), bytes.subarray(20, frameEnd), bytes.subarray(nextEnd)]),
    Buffer.concat([bytes.subarray(0, 20), other.subarray(20, frameEnd), bytes.subarray(frameEnd)])];
  for (const candidate of invalid) await assert.rejects(() => decode(candidate));
  await assert.rejects(() => collect(decryptBackup(chunks(bytes), secret + "wrong")));
});

test("daily backup preserves all canonical sections with bounded uncached scans and reuses completed backups", async () => {
  const id = "media-1234567890-12345678";
  const f = fixture(new Map([
    ["coin-issues:post:BTC:test", { body: "private issue" }], ["coin-issues:hidden:BTC", ["hidden-1"]],
    ["free-board-media:" + id, { storage: "r2", contentType: "video/mp4", fileName: "private.mp4" }],
    ["free-board-media:" + id + ":chunk:0", new Uint8Array(1024 * 1024)],
    ["free-board-media:upload:test", { private: true }],
    ["board-daily-posts:test", 2],
  ]));
  const now = Date.UTC(2026, 10, 27, 18, 17);
  const result = await (await f.store.createDailyBackup(now)).json();
  const restored = await decode(f.stored.get(result.key));
  assert.deepEqual(restored.data.members, f.sections.members);
  for (const [name, value] of Object.entries(f.sections)) assert.deepEqual(restored.data[name], value);
  assert.deepEqual(restored.data.coinIssues, Object.fromEntries([...f.records].filter(([key]) => key.startsWith("coin-issues:"))));
  assert.deepEqual(restored.data.boardDailyPostCounts, { "board-daily-posts:test": 2 });
  assert.equal(restored.data.media.length, 1);
  assert.equal(restored.data.media[0].id, id);
  assert.ok(!JSON.stringify(restored).includes('"private":true'));
  assert.ok(f.lists.every(options => options.limit === 1 && options.noCache));
  assert.ok(f.lists.some(options => options.startAfter === "free-board-media:" + id + ":chunk:\uffff"));
  assert.equal(result.formatVersion, 2);
  const reused = await (await f.store.createDailyBackup(now)).json();
  assert.equal(reused.reused, true);
  assert.equal(reused.formatVersion, 2);
  assert.equal(f.uploads.length, 1);
});

test("legacy attachment metadata backs up each chunk once without bulk-loading binary data", async () => {
  const id = "media-1234567890-12345678", prefix = "free-board-media:" + id;
  const f = fixture(new Map([
    [prefix, { contentType: "video/mp4", chunkCount: 2 }],
    [prefix + ":chunk:0", new Uint8Array([1, 2])],
    [prefix + ":chunk:1", new Uint8Array([3, 4])],
  ]));
  const result = await f.store.readMediaMetadataForBackup();
  assert.equal(result.legacyObjectsCopied, 2);
  assert.equal(result.media.length, 1);
  assert.deepEqual(f.stored.get("legacy-media/" + id + "/chunks/0"), Buffer.from([1, 2]));
  assert.deepEqual(f.stored.get("legacy-media/" + id + "/chunks/1"), Buffer.from([3, 4]));
  assert.equal(f.gets.length, 2);
  assert.ok(f.gets.every(read => read.options.noCache));
  assert.equal((await f.store.readMediaMetadataForBackup()).legacyObjectsCopied, 0);
});

test("large issue archives upload fixed-size parts without loading the whole archive or retaining mutable buffers", async () => {
  const f = fixture();
  const prototype = "x".repeat(32 * 1024);
  let read = 0, outstanding = 0;
  f.store.backupStorageEntries = async function* (prefix) {
    if (prefix !== "coin-issues:") return;
    for (let index = 0; index < 400; index++) { read++; outstanding++; yield ["issue-" + index, { body: prototype + index }]; outstanding--; }
  };
  const original = f.bucket.createMultipartUpload;
  f.bucket.createMultipartUpload = async (...args) => {
    const upload = await original(...args), part = upload.uploadPart;
    upload.uploadPart = async (...values) => {
      assert.ok(outstanding <= 1);
      if (values[0] === 1) assert.ok(read < 200, "first part uploads before the complete archive is read");
      return part(...values);
    };
    return upload;
  };
  const result = await (await f.store.createDailyBackup()).json();
  const parts = f.uploads[0].uploaded;
  assert.ok(parts.length >= 3);
  assert.ok(parts.slice(0, -1).every(part => part.length === 5 * 1024 * 1024));
  assert.ok(parts.at(-1).length <= 5 * 1024 * 1024);
  const restored = await decode(f.stored.get(result.key));
  assert.equal(Object.keys(restored.data.coinIssues).length, 400);
  assert.equal(restored.data.coinIssues["issue-399"].body, prototype + 399);
});

test("failed uploads abort without publishing a completed backup and can be retried", async () => {
  const f = fixture(), original = f.bucket.createMultipartUpload;
  f.bucket.createMultipartUpload = async (...args) => {
    const upload = await original(...args);
    f.uploads.at(-1).failPart = 1;
    return upload;
  };
  await assert.rejects(() => f.store.createDailyBackup(), /synthetic_upload_failure/);
  assert.equal(f.stored.size, 0);
  assert.equal(f.uploads[0].aborted, true);
  assert.equal(f.store.dailyBackupOperation, null);
  f.bucket.createMultipartUpload = original;
  assert.equal((await (await f.store.createDailyBackup()).json()).ok, true);
});

test("concurrent backups share one upload, while callers receive independent readable responses", async () => {
  const f = fixture(), responses = await Promise.all([f.store.createDailyBackup(), f.store.createDailyBackup()]);
  assert.equal(f.uploads.length, 1);
  assert.deepEqual(await responses[0].json(), await responses[1].json());
});

test("R2 media backup pipes the source body without materializing an arrayBuffer", async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
  let received;
  const env = { BOARD_MEDIA_BUCKET: {
    async put() {},
    async list() { return { objects: [{ key: "free-board-media/test", size: 3 }], truncated: false }; },
    async get() { return { body, async arrayBuffer() { throw new Error("must_not_buffer"); } }; },
  }, BACKUP_BUCKET: { async head() { return null; }, async put(key, value) { received = value; } } };
  assert.equal((await syncBoardMediaToBackup(env)).copied, 1);
  assert.equal(received, body);
});

test("local restore removes partial plaintext on authentication failure and never overwrites existing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coin-backup-test-"));
  try {
    const input = join(directory, "input.cbk"), output = join(directory, "output.json");
    const bytes = await collect(encryptBackupFrames(strings(['{"ok":true}']), { SESSION_SECRET: secret }));
    await writeFile(input, bytes.subarray(0, -1));
    await assert.rejects(() => restoreBackup(input, output, secret));
    assert.deepEqual(await readdir(directory), ["input.cbk"]);
    await writeFile(input, bytes);
    await restoreBackup(input, output, secret);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { ok: true });
    await assert.rejects(() => restoreBackup(input, output, secret), /EEXIST/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
