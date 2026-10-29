import identity from "../../comparison-identity.js";

const mintUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
mintUrl.searchParams.set("audience", "coin-board-auth-market-data");
const mint = await fetch(mintUrl, { headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
if (!mint.ok) throw new Error(`oidc_mint_failed:${mint.status}`);
const { value: token } = await mint.json();
if (!token) throw new Error("oidc_token_missing");
let failed = 0;
for (const board of ["fx", "upbit", "bithumb", "binance", "coinbase", "gateio", "bybit", "bitget", "okx", "audit", "bootstrap"]) {
  try {
    let result;
    for (let attempt = 0; attempt < 13; attempt += 1) {
      let response;
      for (let transportAttempt = 0; transportAttempt < 3; transportAttempt += 1) {
        try {
          response = await fetch(`https://coin-board-auth.dlatl20000.workers.dev/api/market-data?probeComparison=${board}`, {
            headers: { Authorization: `Bearer ${token}`, "X-Market-Data-Sync": "1" }, signal: AbortSignal.timeout(45000),
          });
          break;
        } catch (error) {
          if (transportAttempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * (transportAttempt + 1)));
        }
      }
      if (!response.ok) throw new Error(`probe_http_${response.status}`);
      result = await response.json();
      if (result.implementation === 6) break;
      // Worker deployment acknowledgement precedes worldwide propagation.
      if (attempt === 12) throw new Error("new_worker_not_propagated");
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (board === "audit") {
      const rows = result.local.map(item => {
        const listed = result.references.flatMap(source => source.rows.filter(candidate => identity.symbol(candidate, source.board) === identity.symbol(item.row, item.board))
          .map(candidate => ({ ...candidate, board: source.board })));
        const matches = listed.filter(candidate => identity.matches(item.row, candidate, { baseBoard: item.board, referenceBoard: candidate.board, info: item.info }));
        const domestic = matches.length ? [] : result.local.filter(candidate => candidate.board !== item.board
          && identity.matches(item.row, candidate.row, { baseBoard: item.board, referenceBoard: candidate.board, info: item.info, referenceInfo: candidate.info }));
        return { board: item.board, symbol: item.row.symbol, name: item.row.englishName, capVerified: item.row.marketIdentityVerified,
          matches: matches.map(row => `${row.board}:${row.symbol}`),
          domestic: domestic.length === 1 ? domestic.map(item => `${item.board}:${item.row.symbol}`) : [],
          ...(!matches.length && listed.length ? { candidates: listed.map(row => ({ board: row.board, symbol: row.symbol, name: row.englishName })) } : {}) };
      });
      console.log(JSON.stringify({ exchange: "audit", total: rows.length, matched: rows.filter(row => row.matches.length).length,
        domesticFallback: rows.filter(row => row.domestic.length),
        unverified: rows.filter(row => row.candidates), unavailable: rows.filter(row => !row.matches.length && !row.candidates),
        reported: rows.filter(row => ["SOON", "BEAM", "FLUID", "PIEVERSE", "CC", "WAVES", "B3"].includes(row.symbol)) }));
    } else console.log(JSON.stringify(result));
    if (result.error || result.identityError || (board === "fx" ? !result.rate || result.stale : !["audit", "bootstrap"].includes(board) && !result.quoteCount)) failed += 1;
  } catch (error) { console.log(JSON.stringify({ exchange: board, error: error.message })); failed += 1; }
}
if (failed) console.log(`::warning title=Production quote source issues::${failed} sources require investigation; inspect the sanitized diagnostics above.`);
