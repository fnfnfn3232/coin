const mintUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
mintUrl.searchParams.set("audience", "coin-board-auth-market-data");
const mint = await fetch(mintUrl, { headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
if (!mint.ok) throw new Error(`oidc_mint_failed:${mint.status}`);
const { value: token } = await mint.json();
if (!token) throw new Error("oidc_token_missing");
let failed = 0;
for (const board of ["upbit", "bithumb", "binance", "coinbase", "gateio", "bybit", "bitget", "okx"]) {
  try {
    let result;
    for (let attempt = 0; attempt < 13; attempt += 1) {
      const response = await fetch(`https://coin-board-auth.dlatl20000.workers.dev/api/market-data?probeComparison=${board}`, {
        headers: { Authorization: `Bearer ${token}`, "X-Market-Data-Sync": "1" }, signal: AbortSignal.timeout(45000),
      });
      if (!response.ok) throw new Error(`probe_http_${response.status}`);
      result = await response.json();
      if (result.implementation === 2) break;
      // Worker deployment acknowledgement precedes worldwide propagation.
      if (attempt === 12) throw new Error("new_worker_not_propagated");
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    console.log(JSON.stringify(result));
    if (!result.quoteCount || result.error || result.identityError) failed += 1;
  } catch (error) { console.log(JSON.stringify({ exchange: board, error: error.message })); failed += 1; }
}
if (failed) console.log(`::warning title=Production quote source issues::${failed} sources require investigation; inspect the sanitized diagnostics above.`);
