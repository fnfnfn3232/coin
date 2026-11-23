const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

async function main() {
  const worker = fs.readFileSync(__dirname + '/server-auth/cloudflare-worker.js', 'utf8');
  const helpers = worker.slice(worker.indexOf('function telegramSourceUrl'), worker.indexOf('const USAGE_STATS_KEY'));
  const channels = worker.match(/const TELEGRAM_CHANNELS = (\[[^;]+\]);/)[0] + '\n'
    + worker.match(/const TELEGRAM_TEXT_MAX_BYTES = \d+;/)[0];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH
    || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(async ({ helpers, channels }) => {
      // Drive the Worker selector handlers with a real DOM, including fragmented text callbacks.
      globalThis.HTMLRewriter = class {
        handlers = [];
        on(selector, handler) { this.handlers.push({ selector, handler }); return this; }
        transform(response) {
          return { text: async () => {
            const document = new DOMParser().parseFromString(await response.text(), 'text/html');
            const walk = node => {
              if (node.nodeType === 3) {
                const raw = node.textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
                for (const { selector, handler } of this.handlers) if (handler.text && node.parentElement?.closest(selector)) {
                  for (let i = 0; i < raw.length; i += 3) handler.text({ text: raw.slice(i, i + 3), lastInTextNode: i + 3 >= raw.length });
                }
              }
              if (node.nodeType !== 1) return;
              const end = [];
              for (const { selector, handler } of this.handlers) if (node.matches(selector) && handler.element) handler.element({
                getAttribute: name => node.getAttribute(name), onEndTag: callback => end.push(callback),
              });
              for (const child of node.childNodes) walk(child);
              for (const callback of end) callback();
            };
            walk(document.documentElement); return '';
          } };
        }
      };
      const { parse, validate } = new Function(channels + helpers + ';return {parse:parseTelegramPreview,validate:validateTelegramPage};')();
      const time = new Date(Date.now() - 60000).toISOString();
      const post = (ref, text, date = time) => `<div class="tgme_widget_message" data-post="${ref}">
        <div class="tgme_widget_message_text">${text}</div><a class="tgme_widget_message_date"><time datetime="${date}"></time></a></div>`;
      const html = post('BChoSN/123', '비트코인 <b>BTC</b><br>ETH &amp; &#xC2A4;&#53580;&#51060;&#48660; &lt;script&gt;')
        + post('BChoSN/124', 'SKY <a href="https://evil.test">소식</a>')
        + post('evil/125', '잘못된 채널') + post('BChoSN/not-id', '잘못된 번호')
        + post('BChoSN/126', '', time);
      const valid = validate(await parse(html, 'BChoSN'), 'BChoSN');
      let futureRejected = false, overflowRejected = false, oversizedTextRejected = false;
      try { validate(await parse(html + post('BChoSN/127', '미래', new Date(Date.now() + 86400000).toISOString()), 'BChoSN'), 'BChoSN'); }
      catch (_error) { futureRejected = true; }
      try { await parse(Array.from({ length: 201 }, (_, i) => post('BChoSN/' + (i + 1), '글')).join(''), 'BChoSN'); }
      catch (_error) { overflowRejected = true; }
      const longText = '원문 첫 문장입니다.\n\n' + 'a'.repeat(25000) + '\n마지막 문장';
      const long = validate(await parse(post('BChoSN/128', longText.replaceAll('\n', '<br>')), 'BChoSN'), 'BChoSN')[0];
      try { validate(await parse(post('BChoSN/129', 'a'.repeat(80001)), 'BChoSN'), 'BChoSN'); }
      catch (_error) { oversizedTextRejected = true; }
      return { messages: valid, futureRejected, overflowRejected, fullTextIntact: long.text === longText, oversizedTextRejected };
    }, { helpers, channels });
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0].text, '비트코인 BTC\nETH & 스테이블 <script>');
    assert.equal(result.messages[0].sourceUrl, 'https://t.me/BChoSN/123');
    assert.equal(result.messages[1].text, 'SKY 소식');
    assert.equal(result.messages[2].text, '', 'media-only messages remain pagination boundaries');
    assert.equal(result.futureRejected, true);
    assert.equal(result.overflowRejected, true, 'oversized pages fail instead of silently truncating');
    assert.equal(result.fullTextIntact, true, 'the old 20,000-character slicing limit cannot truncate authorized text');
    assert.equal(result.oversizedTextRejected, true, 'the safety limit fails explicitly instead of publishing a partial original');
    console.log('PASS: Telegram selector parser handles nested and fragmented text, entities, dates and strict source links');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
