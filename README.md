# ByteZone Connect

ByteZone Connect is the existing public website plus a Node.js operations portal for device rentals, inventory/POS, private-content removal requests, and ByteZone POS inquiries.

## Run locally

Requirements: Node.js 20 or newer and npm.

1. Run the setup helper to create `.env` with a randomly generated encryption key:

   ```powershell
   npm run setup
   ```

   The helper does not overwrite an existing `.env`. Back up the generated key securely; losing it makes encrypted profiles, fingerprint templates, inquiries, tickets, and vault uploads unreadable.
2. Install and start:

   ```powershell
   npm install
   npm start
   ```

   The site is at `http://localhost:3000/`; the operations portal is at `http://localhost:3000/ops`.

   If you are previewing `index.html` using VS Code Live Server on port 5500, keep the Node server running as well. The portal menu link automatically opens the app server at port 3000; Live Server by itself cannot run the API or portal.
3. Create the first admin or staff account in a terminal:

   ```powershell
   npm run create-user
   ```

   Use the `admin` role for device pricing, inventory and reports, and takedown ticket management. Customer accounts can register from the portal.

`npm start` builds the Tailwind stylesheet and runs pending migrations. `npm run build` (or `npm run build:netlify`) creates the static Netlify deployment output in `dist/`; `npm run build:css` only compiles the portal stylesheet. `VITE_API_URL` is not used: this is not a Vite app, and Netlify proxies `/api/*` to Railway using its server-side `BYTEZONE_BACKEND_URL` and `BYTEZONE_PROXY_SECRET` settings. To apply migrations separately, use `npm run migrate`. `npm test` runs the focused API/security tests.

## Security and operations

- Customer profiles, rental customer snapshots, POS inquiries, takedown URL/details, and biometric templates use AES-256-GCM field encryption. Email lookup uses a keyed HMAC; passwords use scrypt hashes. Uploaded evidence is encrypted before it is written to `storage/vault/`; it is never served as a public static file.
- `BYTEZONE_ENCRYPTION_KEY` must be a 64-character hexadecimal key. Configure it through a secret manager in production. Do not rotate or replace it without a tested re-encryption/backup plan.
- Configure HTTPS in production and set `NODE_ENV=production` so session cookies are Secure. Store `data/` and `storage/` on restricted, encrypted disks and include them in protected backups.
- The database currently uses a single-process, pure-WASM SQLite adapter for local/small-site use. Every write persists the SQLite image; do not run multiple server instances against the same file. For high-volume or multi-instance production, replace this adapter with a managed transactional database before launch.
- Money is integer MWK. Default rentals are Laptop 6,700 MWK/hour, Desktop PC 4,000 MWK/hour, Gaming PC 5,999 MWK/hour, and PS5 Gaming Console 15,000 MWK/day. Rental charges round up to a full billing interval with a one-interval minimum.
- POS payment methods record staff-confirmed cash/mobile-money/card sales; no payment processor is connected. The MWK 4,900,899 package button records a payment inquiry, not a charge.
- Removal requests require an HTTPS URL, written ownership explanation, and evidence file. Staff manually review and update statuses; the system does not automatically contact websites or guarantee removal.

## Fingerprint scanner bridge

No DigitalPersona or SecuGen vendor SDK is included. Install and secure a local bridge using the scanner manufacturer's licensed SDK, then set `BYTEZONE_SCANNER_URL` and `BYTEZONE_SCANNER_TOKEN`. The bridge contract is:

- `GET /health` with `Authorization: Bearer TOKEN` returns HTTP 200 when a scanner is ready.
- `POST /enroll` with `{ "subjectId": "<user id>" }` captures a fingerprint and returns `{ "template": "<base64 template>" }`.
- `POST /verify` with `{ "subjectId": "<user id>", "template": "<base64 template>" }` performs the scan/match and returns `{ "matched": true|false }`.

The bridge must not retain or log templates. Keep it bound to loopback or use HTTPS and a strong token. The app encrypts templates in the database; it never stores fingerprint images. If no bridge is configured or available, password verification is used. A failed fingerprint match is not treated as scanner failure.

## Deploy the portal online (Netlify + Railway)

Netlify serves the marketing site as static files; it cannot run `server.js` or retain the SQLite database and evidence files. `netlify.toml` now routes `/ops`, portal assets, and `/api/*` through a Netlify Function to the Railway Node service. The build publishes only the approved static website assets, not the application source. Railway runs the existing Node application with persistent storage for the database and encrypted evidence vault.

1. Deploy this repository as a new Railway service using the repository root. Railway reads `railway.json`; wait for its generated HTTPS domain, for example `https://your-service.up.railway.app`.
2. Add a Railway volume mounted at `/app/data`. Set these Railway service variables:
   - `NODE_ENV=production`
   - `BYTEZONE_DATABASE_PATH=/app/data/bytezone.sqlite`
   - `BYTEZONE_VAULT_PATH=/app/data/vault`
   - `BYTEZONE_ENCRYPTION_KEY` to a new 64-character hexadecimal key
   - `BYTEZONE_PROXY_SECRET` to a new random value of at least 32 characters
   - `BYTEZONE_PUBLIC_ORIGIN` to the exact HTTPS origin of the Netlify site, without a trailing slash (for example `https://your-site.netlify.app`)
3. In Netlify site settings, configure the same repository and root base directory. Add these Functions environment variables (not client/build variables):
   - `BYTEZONE_BACKEND_URL` set to the Railway HTTPS domain
   - `BYTEZONE_PROXY_SECRET` set to the exact same secret as the Railway service
   Deploy or trigger a new deploy so both the static build and function receive the configuration.
4. Open `https://your-site.netlify.app/ops`. Netlify `/api/health` should return `{"status":"ok"}`. Create the first admin account using a Railway shell attached to the service and its mounted volume: run `npm run create-user`.

The Railway domain is intentionally not hard-coded in the repository: it is assigned when the service is created. Keep the proxy secret and encryption key in the two hosts' secret/environment settings, never in Git. The Railway volume is required; the service refuses to start in production without the proxy secret and HTTPS public origin.

## Database migrations

Ordered SQL migrations live in `migrations/` and are recorded in `schema_migrations`. The initial migration creates users/sessions, rental devices/history/payments, inventory/sales, removal tickets, encrypted vault-file metadata, and POS purchase inquiries. The first run seeds the four default rental devices.
