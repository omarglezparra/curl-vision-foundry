# MiniApp security notes

## Pinned Mentra SDK patch

`@mentra/sdk` is pinned to `2.1.29` and patched during `npm ci` by `patch-package`.
The upstream webhook currently has no signature or authentication and accepts a WebSocket URL from
the request before sending the app API key over that connection. The local patch contains that risk by:

- accepting only exact DNS names from `MENTRA_WEBSOCKET_ALLOWED_HOSTS`;
- requiring `wss`, port 443/default, the expected `/app-ws` and `/ws/miniapp` paths, no URL credentials/query/fragment, and one host across all supplied URL fields;
- requiring a current webhook timestamp and bounded identifiers;
- rate-limiting the webhook and returning generic errors;
- disabling unused SDK settings, tool, and photo-upload routes in production;
- enabling secure production cookies and removing secret URLs/tokens from SDK logs.

This containment does not authenticate the webhook sender. Before public launch, ask Mentra to confirm
the exact production WebSocket hostname(s) and whether signed webhooks or mTLS are available. Keep the
MiniApp API key out of logs and rotate it if an unpatched endpoint was ever public.

After every SDK update, remove the old patch only in a dedicated branch, re-run the malicious-webhook
smoke test, inspect upstream for a real verifier, and create a new pinned patch if the defect remains.

Primary upstream references (commit `1a424d55ffab62a0572da8954dc9836ca5c088d5`):

- Cloud webhook construction: https://github.com/Mentra-Community/MentraOS/blob/1a424d55ffab62a0572da8954dc9836ca5c088d5/cloud/packages/cloud/src/services/session/AppManager.ts#L975-L1011
- Future signed-webhook plan: https://github.com/Mentra-Community/MentraOS/blob/1a424d55ffab62a0572da8954dc9836ca5c088d5/cloud/packages/cloud/src/api/api-service-refactor-plan.md#L77-L82
- Current v3 WebSocket API-key header: https://github.com/Mentra-Community/MentraOS/blob/1a424d55ffab62a0572da8954dc9836ca5c088d5/cloud/packages/sdk/src/internal/_SessionManager.ts#L207-L224
