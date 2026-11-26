import { createReadStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function* decryptBackup(chunks, secret) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("backup_secret_required");
  const iterator = chunks[Symbol.asyncIterator]();
  let pending = new Uint8Array(), offset = 0;
  async function take(length, allowEnd = false) {
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (offset === pending.byteLength) {
        const next = await iterator.next();
        if (next.done) {
          if (!written && allowEnd) return null;
          throw new Error("backup_truncated");
        }
        pending = next.value;
        offset = 0;
        continue;
      }
      const size = Math.min(length - written, pending.byteLength - offset);
      result.set(pending.subarray(offset, offset + size), written);
      offset += size;
      written += size;
    }
    return result;
  }
  const magic = await take(4);
  if (magic[0] !== 0x43 || magic[1] !== 0x42 || magic[2] !== 0x4b || ![1, 2].includes(magic[3])) {
    throw new Error("backup_format_invalid");
  }
  const version = magic[3];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`coin-site-backup-v${version}:${secret}`));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
  if (version === 1) {
    const iv = await take(12), rest = [pending.subarray(offset)];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    yield new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, Buffer.concat(rest)));
    return;
  }
  const header = new Uint8Array(20);
  header.set(magic);
  header.set(await take(16), 4);
  for (let index = 0; index < 0xffffffff; index++) {
    const frame = await take(17);
    const size = new DataView(frame.buffer).getUint32(1);
    if (frame[0] > 1 || size < 16 || size > 64 * 1024 + 16 || frame[0] === 1 && size !== 16) {
      throw new Error("backup_frame_invalid");
    }
    const aad = new Uint8Array(25);
    aad.set(header);
    new DataView(aad.buffer).setUint32(20, index);
    aad[24] = frame[0];
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: frame.subarray(5), additionalData: aad }, key, await take(size)));
    if (frame[0] === 1) {
      if (await take(1, true)) throw new Error("backup_trailing_data");
      return;
    }
    yield plaintext;
  }
  throw new Error("backup_frame_limit");
}

export async function restoreBackup(input, output, secret) {
  // Never overwrite a file; remove partial plaintext if authentication fails.
  const file = await open(output, "wx", 0o600);
  const source = createReadStream(input);
  try {
    for await (const bytes of decryptBackup(source, secret)) await file.writeFile(bytes);
    await file.close();
  } catch (error) {
    await file.close();
    await unlink(output);
    throw error;
  } finally {
    source.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("Usage: node server-auth/restore-backup.mjs INPUT.cbk OUTPUT.json (BACKUP_RESTORE_SECRET required)");
    process.exitCode = 1;
  } else {
    try {
      await restoreBackup(input, output, process.env.BACKUP_RESTORE_SECRET);
      console.log("Backup authenticated and restored locally. No production data was changed.");
    } catch (error) {
      console.error("Backup restore failed:", error.message);
      process.exitCode = 1;
    }
  }
}
