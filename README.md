# Secret AI Chatbot

A streaming chat UI for Ollama models running on confidential VMs (TEE), with a built-in TEE attestation panel that verifies the integrity of the server you're talking to.

## What it does

- Connects to one or more Ollama servers running inside Intel TDX or AMD SEV-SNP confidential VMs
- Streams model responses to the browser
- Lets the user switch between models discovered across all configured servers
- Displays a **Verification Center** side panel showing CPU attestation, TLS binding, workload, GPU attestation, and Proof of Cloud for the currently selected model's server

## Quick start

```bash
npm install
```

Create a `.env` file:

```
API_KEY=<your-secretai-api-key>
SERVERS=prod,jedi
# Optional: arbitrary additional Ollama URLs (comma-separated)
EXTRA_SERVERS=https://my-vm.com:21434,http://other-vm:30080
```

Run:

```bash
npm start
```

Open http://localhost:3000.

## Configuration

| Env var | Meaning |
|---------|---------|
| `API_KEY` | Bearer token used to authenticate to Ollama proxies (Caddy on the secret VMs) |
| `SERVERS` | Comma-separated list of server keys from the built-in `SERVERS` map in `server.js` (`prod`, `lambda`, `jedi`) |
| `EXTRA_SERVERS` | Comma-separated full URLs added at startup. Their attestation hostname is derived from the URL |
| `DOMAIN_NAME` | Used only by `docker-compose-secretvm.yaml` for Traefik's TLS routing |

Users can also add ad-hoc server URLs via the **+ Server** button in the UI — these persist in `localStorage`.

## Where the verification logic lives

> **All TEE attestation verification runs on the server side**, not in the browser.

This is required because the [`secretvm-verify`](https://github.com/scrtlabs/secretvm-verify) SDK is Node.js-only: it uses Node's `crypto` module, makes outbound HTTPS calls to NVIDIA NRAS / AMD KDS / Intel PCCS / the SecretAI quote-parse endpoint, and caches certificates on disk. None of that works in a browser.

### Server: `server.js`

1. At startup, the ESM-only `secretvm-verify` package is loaded dynamically and the `checkSecretVm` function is cached at module scope:

   ```js
   let checkSecretVm;
   import("secretvm-verify").then((m) => { checkSecretVm = m.checkSecretVm; });
   ```

2. When the frontend hits `GET /api/attestation?server=<key>` (or `?host=<hostname>` for ad-hoc URLs), the backend calls:

   ```js
   const result = await checkSecretVm(host, "", false, true);
   ```

   This performs the full end-to-end attestation: connects to the VM's port 29343, fetches the CPU quote, fetches the TLS cert, verifies the quote against the hardware vendor's root of trust, verifies that the TLS cert is bound to the quote, fetches and verifies the GPU attestation through NVIDIA's NRAS, and (optionally) checks proof of cloud.

3. The backend extracts the relevant fields from the raw SDK result and returns a curated JSON envelope to the browser, e.g.:

   ```json
   {
     "valid": true,
     "checks": {
       "cpu": { "passed": true, "platform": "AMD SEV-SNP", ... },
       "tlsBinding": { "passed": true, "fingerprint": "..." },
       "workload": { "passed": true, "status": "authentic_match", ... },
       "gpu": { "present": true, "passed": true, "cpuBound": true, ... },
       "proofOfCloud": { "passed": false }
     },
     "links": { ... },
     "errors": [...]
   }
   ```

   The overall `valid` flag treats Proof of Cloud as advisory and missing GPU checks as "not applicable" rather than failures.

### Client: `public/index.html`

The browser performs **no cryptographic verification of its own.** Its responsibilities are:

- Call `GET /api/attestation` whenever the user selects a model
- Render the JSON returned by the backend as five expandable items (CPU, Workload, TLS Binding, GPU, Proof of Cloud)
- Maintain the open/closed state of the side panel and the loading/success/error state of the header badge

The entire Verification Center UI lives in the single `public/index.html` file:

- **HTML structure** — the `<div id="side-panel">` block contains the panel header, status banner, "Verify Again" button, the `<div id="attestation-list">` placeholder where items are rendered, and the footer link. The "Verified Confidential" badge sits in the header bar.
- **CSS** — all styles are in the inline `<style>` block. Relevant classes: `.tee-badge` (header pill with loading/error states + spin animation), `.side-panel` / `.side-panel-inner` (the slide-in drawer with `width` transition), `.status-banner` (success/failure/loading), `.attest-item` / `.attest-header` / `.attest-body` (each expandable row), `.attest-icon.pass|.fail|.na` (the green / red / grey state icons), `.panel-footer` (the secretvm-verify attribution).
- **JavaScript** — in the inline `<script>` block:
  - `runAttestation()` fires the `GET /api/attestation` request when the model selection changes or "Verify Again" is clicked
  - `setBadgeState(state)` updates the header badge classes/text for loading/success/error
  - `renderAttestation(data)` populates the status banner and rebuilds `#attestation-list` from the JSON
  - `renderAttestItem(title, descriptions, passed, details, link)` returns the HTML string for one expandable row. It branches the icon and copy between three states (`passed === true` → green ✓, `passed === false` → red ✗, `passed === null` → grey em-dash with the `na` description) and toggles the `.expanded` class via inline `onclick`

This means **the browser trusts the server's verification result.** If you want a stronger trust model where the user's own machine performs the verification, you would need to either build a WASM port of the verification logic or send the raw attestation quote + certificate chain to the browser and verify it there with WebCrypto. Neither is implemented.

## Routing logic

`server.js` builds a `modelServerMap` at startup by querying `/api/tags` on every enabled server. When the user selects a model and sends a chat:

- For models from configured servers: backend looks up the server key from the map and routes there
- For models from user-added URLs: frontend sends `serverUrl` in the chat body, backend uses it directly

If the same model name exists on multiple servers, the first server in `SERVERS` order wins.

## Deployment to SecretVM

A GitHub Actions workflow (`.github/workflows/docker-build-secretvm.yml`) builds the Docker image on tag push and generates a `docker-compose-secretvm.yaml` that includes:

- The chatbot image
- A Traefik reverse proxy with TLS using the SecretVM-issued certificates from `/mnt/secure/cert`
- The app reads its env from a `.env` file mounted alongside

To deploy:

```bash
secretvm-cli vm create \
  -n my-chatbot \
  -t small \
  -s \
  -d docker-compose-secretvm.yaml \
  -e .env.secretvm
```

The `.env.secretvm` file must contain `API_KEY`, `SERVERS`, and `DOMAIN_NAME` (matching the VM's `vmDomain`).

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express backend: model discovery, chat streaming, attestation endpoint |
| `public/index.html` | Single-file frontend (chat UI + Verification Center panel) |
| `docker-compose.yaml` | Local Docker deployment with Traefik |
| `docker-compose-secretvm.yaml` | Auto-generated by CI for SecretVM deployment |
| `.github/workflows/docker-build-secretvm.yml` | Build + publish to GHCR + generate compose |
