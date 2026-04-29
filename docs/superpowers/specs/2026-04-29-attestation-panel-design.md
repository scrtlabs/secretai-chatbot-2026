# Attestation Side Panel — Design Spec

## Overview

Add a collapsible side panel to Secret AI Chat that displays attestation verification details for the selected server. Verification runs automatically (async) on server selection using the `secretvm-verify` npm package.

## Server Configuration

Extend the `SERVERS` object in `server.js` to include attestation hostnames:

```js
const SERVERS = {
  prod:   { url: "https://67.215.13.123:21434",           attestHost: "secretai-rytn.scrtlabs.com" },
  lambda: { url: "https://192.222.55.202:21434",          attestHost: "secretai-yyzz.scrtlabs.com" },
  jedi:   { url: "https://secretai-jedi.scrtlabs.com:21434", attestHost: "secretai-jedi.scrtlabs.com" },
};
```

Existing code that reads `SERVERS[key]` as a URL string must be updated to read `SERVERS[key].url`.

## Backend

### Dependency

```bash
npm install secretvm-verify
```

### New Endpoint

`GET /api/attestation?server=<key>`

1. Look up `SERVERS[key].attestHost`
2. Call `checkSecretVm(attestHost)` from secretvm-verify
3. Shape the response for the frontend:

```json
{
  "valid": true,
  "server": "jedi",
  "attestHost": "secretai-jedi.scrtlabs.com",
  "checks": {
    "cpu": {
      "passed": true,
      "platform": "Intel TDX",
      "tcbStatus": "UpToDate",
      "mrtd": "a3f1...c82d"
    },
    "workload": {
      "passed": true,
      "status": "authentic_match",
      "templateName": "secret-ai-v1"
    },
    "gpu": {
      "passed": true,
      "model": "H100",
      "secureBoot": true
    },
    "proofOfCloud": {
      "passed": true,
      "origin": "Verified"
    }
  },
  "links": {
    "cpuQuote": "https://secretai-jedi.scrtlabs.com:29343/cpu",
    "dockerCompose": "https://secretai-jedi.scrtlabs.com:29343/docker-compose",
    "gpuAttestation": "https://secretai-jedi.scrtlabs.com:29343/gpu"
  },
  "errors": []
}
```

Field extraction from the SDK result:
- `cpu`: from `result.report` — extract `attestationType` (maps to platform), `tcb_status`, `mr_td` (truncated for display)
- `workload`: from `result.report.workload` — `status`, `template_name`
- `gpu`: from `result.report.gpu_reports[0]` — `model`, `secure_boot`
- `proofOfCloud`: from `result.checks.proof_of_cloud` — pass/fail

If a check is missing (e.g., no GPU on a server), set `passed: null` to indicate "not applicable" rather than failure.

### Error Handling

- If `checkSecretVm` throws, return `{ valid: false, error: "message" }`
- If an individual check fails, the corresponding `passed` field is `false` and `errors` array contains the reason

## Frontend

### Header Badge

Add a **"Verified Confidential"** badge to the right side of the header bar:
- Green pill shape: `background: rgba(16, 185, 129, 0.12)`, `border: 1px solid rgba(16, 185, 129, 0.4)`, `color: #10b981`
- Contains a green dot indicator + text
- Clicking toggles the side panel open/closed
- States:
  - **Loading**: dot replaced with a CSS spinner, text changes to "Verifying..."
  - **Success**: green dot + "Verified Confidential"
  - **Failure**: red dot (`#ef4444`) + "Verification Failed"
  - **Error**: gray dot + "Unavailable"

### Side Panel

- 380px wide, right side of the viewport
- Background: `#22262c`, border-left: `hsla(0,0%,100%,.1)`
- Collapsible — toggled by clicking the header badge or the panel's close button
- Chat area shrinks to accommodate (not an overlay)

#### Panel Contents

1. **Header**: "Verification Center" title + close button, server name + attestation hostname below
2. **Status Banner**: green success or red failure banner
3. **"Verify Again" button**: re-triggers `GET /api/attestation?server=...` bypassing any future caching
4. **Four expandable attestation items**:

| Item | Title | Description | Expanded Details | Link |
|------|-------|-------------|------------------|------|
| 1 | Genuine {Platform} Machine | "This server runs inside a genuine {platform} trusted execution environment. The CPU attestation quote has been cryptographically verified against {vendor}'s root of trust." | Platform, TCB Status, MRTD (truncated) | View raw attestation quote → `{attestHost}:29343/cpu` |
| 2 | Verified Workload | "The software running inside this TEE matches the expected, publicly auditable configuration. No unauthorized code modifications detected." | Status, Template name | View docker-compose → `{attestHost}:29343/docker-compose` |
| 3 | GPU Attestation | "The NVIDIA GPU has been verified through NVIDIA's Remote Attestation Service. Secure boot is active and all firmware measurements are valid." | GPU Model, Secure Boot status | View GPU attestation report → `{attestHost}:29343/gpu` |
| 4 | Proof of Cloud | "The machine's identity has been validated against a known cloud provider. This confirms the server is running on legitimate infrastructure, not a simulated environment." | Origin | (no external link) |

Each item:
- Has a colored icon: green checkmark (`#10b981`) for pass, red X (`#ef4444`) for fail, gray dash for not applicable
- Chevron rotates on expand
- Body is hidden when collapsed

### Color Scheme

- Primary accent: emerald green `#10b981`
- Success backgrounds: `rgba(16, 185, 129, 0.1–0.15)`
- Failure accent: `#ef4444`
- Links: `#34d399`
- Panel background: `#22262c`
- Card background: `#1a1a2e`
- Borders: `hsla(0,0%,100%,.08–.1)`
- Muted text: `#6b6b7b`, `#a0a0b0`

### Behavior

1. **On page load**: verification fires for the default server
2. **On server change**: verification fires automatically; badge shows loading state; panel updates when results arrive (whether open or closed)
3. **"Verify Again" button**: re-runs verification for current server
4. **Panel toggle**: clicking badge or close button; panel state persists across server changes
5. **Loading state**: badge spinner + panel shows "Verifying..." placeholder with subtle pulse animation

## Files Modified

- `server.js` — refactor SERVERS to object format, add `/api/attestation` endpoint
- `public/index.html` — add badge, side panel HTML/CSS/JS
- `package.json` — add `secretvm-verify` dependency

## Out of Scope

- Caching of attestation results
- Attestation history or logging
- Mobile/responsive layout for the panel
