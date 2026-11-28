export function createOidcTokenProvider({ audience, env = process.env, fetchImpl = globalThis.fetch, now = Date.now }) {
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set("audience", audience);
  let value = "", issuedAt = 0, pending;
  return async function token(force = false) {
    if (!force && value && now() - issuedAt < 120000) return value;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`oidc_mint_failed:${response.status}`);
      const result = await response.json();
      if (typeof result.value !== "string" || !result.value) throw new Error("oidc_token_missing");
      value = result.value;
      issuedAt = now();
      return value;
    })().finally(() => { pending = null; });
    return pending;
  };
}
