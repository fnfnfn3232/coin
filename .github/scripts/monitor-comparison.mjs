import { assessComparisonHealth } from './comparison-health.cjs';

const mintUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
mintUrl.searchParams.set('audience', 'coin-board-auth-market-data');
const mint = await fetch(mintUrl, { headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15000) });
if (!mint.ok) throw new Error(`oidc_mint_failed:${mint.status}`);
const { value: token } = await mint.json();
if (!token) throw new Error('oidc_token_missing');
const headers = { Authorization: `Bearer ${token}`, 'X-Market-Data-Sync': '1' };
const endpoint = 'https://coin-board-auth.dlatl20000.workers.dev/api/market-data';
async function request(suffix, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(endpoint + suffix, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`comparison_monitor_http_${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
}
const audit = await request('?probeComparison=audit');
const report = assessComparisonHealth(audit);
const result = await request('?comparisonHealth=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
// Detailed history stays behind a fresh administrator password, not public CI logs.
console.log(JSON.stringify({ checkedAt: result.checkedAt, total: report.rows.length, counts: result.counts, consecutive: result.consecutive }));
if (result.counts.delayed + result.counts.identity + result.counts.fx) {
  console.log('::warning title=Comparison monitor::Unresolved comparisons detected after automatic bulk refresh. Details are in the administrator refresh history.');
}
