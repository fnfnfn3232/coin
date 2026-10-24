# Board Audit

Date: 2026-10-23 (Asia/Seoul)

## Method and Scope

- Map normal, failure, permission and navigation cases to executable tests.
- Reproduce a failure before changing application behavior.
- Run the same browser workflow suite in installed Chrome and Edge.
- Check desktop width 1440 and mobile-layout widths 390 and 320.
- Use intercepted browser APIs and isolated Worker storage/R2 fixtures. No real
  production posts, comments, uploads or membership permissions are modified.
- Re-run board paste, content-cache, permissions and security regressions.

## Checklist

| Area | Checked Cases | Evidence |
| --- | --- | --- |
| Posts | Create, admin/member edit, repeated submit, failure/retry | `test_board_workflows.cjs`, `server-auth/board-permissions.test.mjs` |
| Comments | Create, owner/admin delete, refresh while typing, successful save followed by upstream failure | Browser workflows and Worker permission tests |
| Search | All search scopes, Korean IME, formatted body text, older server posts | Browser workflows |
| Editor | Full/partial selection, undo/redo, plain-text paste, media URLs, safe HTML | `test_board_paste.cjs`, browser workflows |
| Attachments | File/clipboard upload, concurrent batch rejection, partial failure, cancellation, chunk ownership and download | Browser workflows and Worker permission tests |
| Navigation | Late upload/save after opening another draft, background market refresh, comment refresh | Browser workflows |
| Multiple Tabs | Concurrent edits, original editor revision versus refreshed cache revision | Browser workflows and Worker conflict tests |
| Failure | Offline save, temporary server error, daily quota, revoked writing permission | Browser workflows and Worker permission tests |
| Access | Read-only/approved writer/admin, other owners, denied downloads, expired/revoked sessions | Worker permission tests, `test_content_cache.cjs` |
| Security | Forged sessions, untrusted origins, unsafe HTML, download headers, upload ownership, late responses after logout | Worker security/permission tests and browser suites |
| Layout | Read/edit at desktop and narrow mobile widths; no page overflow | Browser workflows and cache tests |

## Reproduced and Fixed in This Audit

1. The server returns up to 200 posts, but the client previously retained only
   80. Pagination, search and restored cache now use the existing server limit.
   This does not introduce more API requests or increase server retention.
2. The client truncated existing post bodies at 12,000 characters despite the
   server's 20,000-character limit. Reading, editing and validation now agree.
3. Media URL conversion altered HTML `href` and `src` attributes. Conversion
   now walks text nodes and preserves intentional links and code samples.
4. An inline-image-only body was considered empty. Safe images/videos now count
   as structured editor content.
5. Attachment merging silently dropped entries beyond ten before validation.
   Overflow is now rejected without deleting the extra input.
6. A market snapshot refresh could rebuild an active compose form. Refreshes now
   retain the current matching form, its fields, cursor and attachment state.
7. Two tabs editing the same original post could silently overwrite each other.
   The server now checks an optional expected content revision inside its
   serialized mutation operation and returns HTTP 409 on a conflict. The editor
   keeps the unsaved input. Comments and views do not change content revisions.

## Verification and Automation

- The expanded browser workflow suite contains 31 cases (previously 13).
- Worker tests cover revision conflicts, invalid versions and legacy clients.
- `Board Regression Checks` runs paste/workflow and Worker permission/security
  tests on relevant pushes and pull requests. It uses mocked APIs, not live data.
- Commands:

```text
node test_board_workflows.cjs
node test_board_paste.cjs
node test_content_cache.cjs
node --test server-auth/board-permissions.test.mjs server-auth/security-regression.test.mjs test_chain_fees_cache.test.cjs
```

## Limits and Remaining Scope

Deletion-policy follow-up: administrator login and ownership are not substitutes
for deletion confirmation. Outside password-verified board management, both posts
and comments now require the matching content password or administrator password.
The Worker rejects empty/wrong passwords and forged management flags, even for an
administrator or owner session. Existing ownership restrictions still apply.
The original test assumption allowing passwordless owner/admin deletion was wrong
for this site's intended behavior and has been replaced with explicit denial tests.

- Narrow desktop-browser viewports are not real-device iOS/Safari or Android
  testing. Firefox, Safari and actual phone keyboards remain unverified.
- No production load test, destructive database test or exhaustive penetration
  test was performed. Automated checks do not prove the absence of all defects.
- Permanent draft autosave was not added. Explicit navigation, a full reload or
  closing a tab can still discard an unsaved draft.
- Legacy clients that omit `expectedRevision` remain compatible. Reload open
  tabs to receive the new conflict protection. No offline write queue was added.
- The server's existing 200-post retention policy remains unchanged; historical
  archiving beyond that limit is a separate feature.

## Post-Link Follow-Up (2026-10-24)

Post navigation previously changed only browser history state, not the URL. A
copied address therefore could not identify the displayed post in another tab.

- Posts now use `#board/post/<post-id>` URLs; the list uses `#board`.
- Explicit post URLs take priority over the tab's previously saved view and are
  retained while initial login is required. Existing board approval still applies.
- A fresh cache that lacks the requested post is refreshed once. Missing posts,
  loading and upstream failures have distinct states, including a retry action.
- A post-level copy command copies the canonical address without exposing login
  credentials or granting access. Clipboard denial is reported rather than hidden.
- `test_board_links.cjs` contains 11 cases covering clean tabs, reload, login,
  stale navigation state, cache misses, slow/failing APIs, history/hash navigation,
  denied access, invalid identifiers, clipboard failure and mobile layout.
- The link suite runs in Chrome and Edge locally and in the existing browser CI.
- Old copies of the bare homepage URL cannot identify a post retroactively;
  reload the site and copy the address again from the relevant post.

## Edit-Password Follow-Up (2026-10-24)

The deletion fix had not applied the same confirmation policy to editing. Admin
login and ownership still bypassed both the edit dialog and server validation.

- Outside verified board management, clicking Edit now opens the password dialog.
- Both `/verify` and `PUT` check the actual post/administrator password, in
  addition to the existing role/ownership and write-approval checks.
- Edit verification alone does not authorize a later passwordless save. The
  confirmed password accompanies the save and is checked again by the Worker.
- Already verified board management reuses its password; leaving management
  restores the per-edit prompt. No credentials are added to URLs or storage.
- Post verification, updating and deletion share the password-enforcing helper
  so the destructive actions no longer use different confirmation policies.
- Browser regressions cover admin and owner prompts, empty/wrong passwords,
  cancellation, confirmed saves, re-opening, a forced editor without credentials,
  actual management login and leaving management. Worker tests reject direct
  passwordless/incorrect requests even from an authenticated administrator.
- The former regression expectation that admin sessions could edit without a
  password has been corrected, rather than retained as the site's intended rule.
