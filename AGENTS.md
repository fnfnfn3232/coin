# Security Policy

After editing either inline script in `index.html`, run
`node security-policy.cjs --write` before browser tests and before committing.
Run `node security-policy.cjs` to verify the published CSP hashes match.
Do not weaken the CSP with `unsafe-inline` or `unsafe-eval` to fix a test.
Browser fixtures that intentionally change trusted inline scripts must use
`withScriptPolicy` from `security-policy.cjs`; injected attack payloads must not.
Keep login expiry, explicit extension limits and password iteration counts unchanged unless requested.
