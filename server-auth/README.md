# Server-side login option

GitHub Pages is static hosting. A password written in `index.html` only hides the screen; it does not protect `data.js` or API responses. Real login validation needs a server API that checks the password before returning protected data.

This folder contains a Cloudflare Worker template for that server API.

## What changes

- Password is not stored in `index.html`.
- Browser sends password to `/api/login`.
- Worker validates it against a secret hash stored in Cloudflare environment variables.
- Worker sets an `HttpOnly` session cookie.
- Protected APIs, such as `/api/news`, return data only when that cookie is valid.
- Coinness news full text should still be used carefully. Default mode returns previews only.

## Required Cloudflare Worker environment variables

- `FRONTEND_ORIGIN`
  - Example: `https://fnfnfn3232.github.io`
- `SITE_PASSWORD_SHA256`
  - SHA-256 hex of the site password.
- `SESSION_SECRET`
  - Long random string used to sign session cookies.
- `NEWS_LIMIT`
  - Optional. Default behavior in code caps this at 100.
- `NEWS_BODY_MODE`
  - Optional. Use `preview` by default.
  - `full` returns full Coinness text only after login, but this can still carry content-license risk.

## Generate password hash

In PowerShell:

```powershell
$password = "your-password-here"
$bytes = [Text.Encoding]::UTF8.GetBytes($password)
$hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
($hash | ForEach-Object { $_.ToString("x2") }) -join ""
```

## API shape

Login:

```http
POST /api/login
Content-Type: application/json

{"password":"..."}
```

News:

```http
GET /api/news
Cookie: coin_board_session=...
```

Logout:

```http
POST /api/logout
```

## Important limitation

This protects data served by the Worker. It does not protect any data that is still committed into public `data.js`, `board_snapshot.json`, or the GitHub repository. If full text should be private, do not write it to those files.

