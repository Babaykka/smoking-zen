# Production configuration

Production mode is fail-closed: set `APP_MODE=production`, configure every production variable from `.env.example`, and open the app through Telegram Mini Apps. Demo data is available only when `APP_MODE=demo` is set explicitly.

Use the Supabase publishable key in the browser. Keep the service-role key and the ES256 PKCS#8 private key server-only. Import the corresponding ES256 public key into the Supabase trusted signing-key set and set `SUPABASE_JWT_KID` to that key's `kid`.

The server exchanges Telegram `initData` for an HTTP-only application session, verifies active workspace membership, and mints a five-minute JWT carrying the dedicated `smoking_zen_scope=realtime` claim. The browser keeps that JWT only in memory, refreshes it one minute before expiry, and applies each refreshed token to the existing private workspace channel. The claim authorizes receive-only access to the token's own private Realtime topic; it does not authorize direct table, RPC, Broadcast-send, or Storage access. Do not place Realtime tokens in URLs, browser storage, logs, or error messages.

Task and comment writes use a new service-role client for each request with a server-controlled audit actor header. The database accepts that actor only when the user is active in the same non-deleted workspace; invalid or cross-workspace actor values are recorded as `null`.

All browser business-data operations go through the Next API. Direct `anon` and `authenticated` privileges are revoked from current and future public tables, sequences, and functions; Storage object access remains server-only until the dedicated file flow is introduced.
