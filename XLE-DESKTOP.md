# XLE desktop administration

This fork adds a Phase 1 administration panel to Haven Desktop. Open a Haven
server, sign in as a server administrator, then choose **View → XLE
Administration**, or press **Ctrl+Shift+L** (**Cmd+Shift+L** on macOS).
The shortcut is a menu accelerator, not a global keyboard hook. It also works
when the application menu is hidden.

## Required server support

The connected Haven server must include the XLE foundation from
[`XorishiTtv/Haven`, branch `feature/xle-phase1-foundation`](https://github.com/XorishiTtv/Haven/tree/feature/xle-phase1-foundation)
or its merged equivalent. This desktop change does not merge or activate that
server branch. See the server's `XLE-PHASE1.md` for configuration and privacy
requirements. A normal Haven server without those routes gets an unavailable
message; the client does not substitute another service.

The panel uses these existing administrator-only endpoints:

| Action | Endpoint | Effect |
| --- | --- | --- |
| Refresh status | `GET /api/xle/status` | Engine and provider readiness, including direct AI egress policy |
| List characters | `GET /api/xle/characters` | Configured identities, providers, enabled states, provisioning and channel binding |
| Provision | `POST /api/xle/characters/:id/provision` | Creates a persistent webhook bot identity after reviewing the character and channel ID |
| AI preview | `POST /api/xle/characters/:id/preview` | Sends an explicit prompt to the server for a manual provider response |

Provisioning requires an existing non-DM channel's **numeric database ID**, not
its invite code. The server checks the channel, administrator privileges,
character state, and installed canon. Provisioning does not start autonomous
conversations or grant moderation or voice permissions. A provisioned identity
is disabled for further provisioning in the panel; the server also prevents
duplicates. If a provisioning request loses its connection, refresh the list
before retrying, since the server may already have created it.

AI preview is available only when the engine and character are enabled and the
provider reports configured credentials/model and permitted direct AI egress.
It accepts at most 1,000 characters. The confirmation text explains the provider
request and potential cost. Preview responses render as plain text and are not
posted to chat or written as XLE memory. Closing the panel cancels pending
client requests; it cannot guarantee that a provider request already started by
the server is cancelled or unbilled.

## Configuration and memory limits

Phase 1 has no HTTP API for editing the registry, provider assignments,
personalities, or memories. The panel shows these limits without offering
nonfunctional controls. Edit approved lore and `xle.config.json` on the server;
keep OpenAI/xAI keys and model settings in its private environment. Memory
review, deletion, and retention controls need corresponding server APIs before
they can be implemented here. No canon, provider keys, or member memory is
bundled with the desktop panel.

The registry remains server-owned, including character names and provider
assignments; the desktop does not hard-code a replacement character lineup.

## Security and origin privacy

- The existing Haven bearer token is used only for fixed paths on the current
  server origin. It is not copied to Electron main, another origin, logs, a new
  configuration file, or a new storage entry. HTTP redirects are rejected.
- UI gating is only a convenience. Every server endpoint independently verifies
  the bearer token and the current administrator role from the database.
- Closing aborts pending requests. Local token/account/role changes clear the
  panel; a server `401` or `403` clears it as well. Reopen after signing in again.
- The panel has no new privileged IPC commands and runs with the existing
  isolated preload and disabled Node integration for server pages.
- Character metadata is schema-checked and reduced to fields used by the UI.
  Arbitrary error bodies are replaced by safe messages; known configuration
  errors get specific guidance. Server strings and AI output use `textContent`.
- A refresh makes two requests. There is no background API polling. The panel
  handles the foundation's 12-request/minute limit with a wait-and-retry message.
- This UI does not hide a Haven origin IP. Direct AI egress exposes the outbound
  server IP to OpenAI/xAI, and the panel flags that policy. The foundation's
  isolated AI gateway is still future server work; do not enable direct egress
  on a hidden origin as a substitute for that gateway.

## Fork updates and validation

`electron-builder.yml` now publishes and discovers updates from
`XorishiTtv/Haven-Desktop`, rather than the upstream repository. This prevents
future upstream releases from replacing the XLE fork. No installer or release
is published by this change.

Run:

```sh
npm test
npm run i18n:check
```

`test/xle-admin.test.js` covers authentication changes, cancellation, fixed
routes, response validation, safe errors, and provisioning/preview payloads.
The existing page-world tests also execute the complete injected module.
DOM workflow checks were additionally run against mocked Phase 1 endpoints for
non-admin access, all five character cards, reviewed provisioning, duplicate
submissions, disabled actions, literal markup in responses, session changes,
and closing during a request.

English and Brazilian Portuguese labels are supplied. The inherited translation
check is also repaired to recognize the screen picker's generated key list and
the XLE error maps, with missing existing Portuguese messages filled in.

Windows/Linux installers and a live Haven/provider integration still require
the normal native build environment and a configured XLE server. They have not
been validated by the mocked endpoint tests.
