'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const marker = /<meta http-equiv="Content-Security-Policy" content="[^"]*"\s*\/>/;

function withScriptPolicy(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\bsrc\s*=/i.test(match[1]));
  if (scripts.length !== 2) throw new Error('Unexpected inline scripts; review the script policy before publishing');
  const hashes = scripts.map(match => `'sha256-${createHash('sha256').update(match[2].replace(/\r\n?/g, '\n')).digest('base64')}'`);
  const policy = `script-src 'self' ${hashes.join(' ')}; script-src-attr 'none'; object-src 'none'; base-uri 'none'; form-action 'self' https://coin-board-auth.dlatl20000.workers.dev`;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
  if (!marker.test(html)) throw new Error('Missing script policy marker');
  return html.replace(marker, meta);
}

module.exports = { withScriptPolicy };

if (require.main === module) {
  const file = path.join(__dirname, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const secured = withScriptPolicy(html);
  if (process.argv.includes('--write')) {
    if (html !== secured) fs.writeFileSync(file, secured);
  } else if (html !== secured) {
    throw new Error('Inline scripts changed. Run node security-policy.cjs --write, then rerun browser tests.');
  }
}
