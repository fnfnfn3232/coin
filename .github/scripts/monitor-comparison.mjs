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
if (process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT) report.reportId = `${process.env.GITHUB_RUN_ID}:${process.env.GITHUB_RUN_ATTEMPT}`;
const result = await request('?comparisonHealth=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
if (result.alertVersion !== 1) throw new Error('comparison_alert_policy_not_deployed');
// Detailed history stays behind a fresh administrator password, not public CI logs.
console.log(JSON.stringify({ alertVersion: result.alertVersion, checkedAt: result.checkedAt, total: report.rows.length, counts: result.counts,
  activeAlerts: result.activeAlerts || 0, newAlerts: result.newAlerts || 0, recoveredAlerts: result.recoveredAlerts || 0 }));
if (result.newAlerts > 0) {
  console.log('::error title=Persistent comparison incident::A new unresolved incident persisted across at least three checks and 30 minutes. Details require a fresh administrator password. No AI job was started.');
  process.exitCode = 1;
}
