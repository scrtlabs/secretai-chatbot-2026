# Attestation Side Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible side panel to Secret AI Chat that shows live TEE attestation verification results for the selected server, using the secretvm-verify SDK.

**Architecture:** Backend calls `checkSecretVm()` from secretvm-verify via a new `/api/attestation` endpoint. Frontend adds a "Verified Confidential" badge in the header that toggles a right-side panel displaying 4 expandable verification items. Verification fires automatically on server selection.

**Tech Stack:** Node.js/Express (existing), secretvm-verify (npm, ESM-only — requires dynamic import), vanilla JS/CSS frontend (existing pattern).

**Reference:** Design spec at `docs/superpowers/specs/2026-04-29-attestation-panel-design.md`, visual mockup approved by user (green color scheme, emerald `#10b981`).

---

### Task 1: Install secretvm-verify and refactor SERVERS config

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `server.js:11-22` (refactor SERVERS object, update getOllamaUrl)

- [ ] **Step 1: Install secretvm-verify**

Run:
```bash
npm install secretvm-verify
```

- [ ] **Step 2: Refactor SERVERS to include attestation hostnames**

In `server.js`, replace lines 11-22:

```js
const SERVERS = {
  prod:   "https://67.215.13.123:21434",
  lambda: "https://192.222.55.202:21434",
  jedi:   "https://secretai-jedi.scrtlabs.com:21434",
};
const DEFAULT_SERVER = "prod";
const API_KEY = process.env.API_KEY || "";

function getOllamaUrl(req) {
  const key = req.query.server || req.body?.server || DEFAULT_SERVER;
  return SERVERS[key] || SERVERS[DEFAULT_SERVER];
}
```

With:

```js
const SERVERS = {
  prod:   { url: "https://67.215.13.123:21434",              attestHost: "secretai-rytn.scrtlabs.com" },
  lambda: { url: "https://192.222.55.202:21434",             attestHost: "secretai-yyzz.scrtlabs.com" },
  jedi:   { url: "https://secretai-jedi.scrtlabs.com:21434", attestHost: "secretai-jedi.scrtlabs.com" },
};
const DEFAULT_SERVER = "prod";
const API_KEY = process.env.API_KEY || "";

function getOllamaUrl(req) {
  const key = req.query.server || req.body?.server || DEFAULT_SERVER;
  const server = SERVERS[key] || SERVERS[DEFAULT_SERVER];
  return server.url;
}
```

- [ ] **Step 3: Verify existing functionality still works**

Run:
```bash
pkill -f "node server.js" 2>/dev/null; sleep 1; node server.js &
sleep 2
curl -s http://localhost:3000/api/servers
```

Expected: `["prod","lambda","jedi"]`

```bash
curl -s "http://localhost:3000/api/models?server=jedi"
```

Expected: JSON array of model names (or `[]` if server is loading).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json server.js
git commit -m "Refactor SERVERS config to include attestation hostnames

Add secretvm-verify dependency. Change SERVERS from string values to
objects with url and attestHost fields. Update getOllamaUrl accordingly."
```

---

### Task 2: Add /api/attestation backend endpoint

**Files:**
- Modify: `server.js` (add endpoint after `/api/servers` route, around line 29)

- [ ] **Step 1: Add the attestation endpoint**

Insert the following after the `/api/servers` endpoint (after line 29 in the original, adjust for Task 1 changes):

```js
app.get("/api/attestation", async (req, res) => {
  const key = req.query.server || DEFAULT_SERVER;
  const server = SERVERS[key];
  if (!server) {
    return res.status(400).json({ valid: false, error: "Unknown server" });
  }

  try {
    const { checkSecretVm } = await import("secretvm-verify");
    const result = await checkSecretVm(server.attestHost, "", false, true);

    const attestHost = server.attestHost;
    const baseAttestUrl = `https://${attestHost}:29343`;

    const response = {
      valid: result.valid,
      server: key,
      attestHost: attestHost,
      attestationType: result.attestationType || "Unknown",
      checks: {
        cpu: {
          passed: result.checks.cpu_quote_verified ?? null,
          platform: result.attestationType === "SECRET-VM" ? (result.report.cpu_type || "TDX") : (result.attestationType || "Unknown"),
          tcbStatus: result.report.tcb_status || null,
          mrtd: result.report.mr_td ? (result.report.mr_td.substring(0, 8) + "..." + result.report.mr_td.slice(-4)) : null,
        },
        workload: {
          passed: result.checks.workload_binding_verified ?? null,
          status: result.report.workload?.status || null,
          templateName: result.report.workload?.template_name || null,
        },
        gpu: {
          passed: result.checks.gpu_quote_verified ?? null,
          model: result.report.gpu_reports?.[0]?.model || null,
          secureBoot: result.report.gpu_reports?.[0]?.secure_boot ?? null,
        },
        proofOfCloud: {
          passed: result.checks.proof_of_cloud_verified ?? null,
        },
      },
      links: {
        cpuQuote: `${baseAttestUrl}/cpu`,
        dockerCompose: `${baseAttestUrl}/docker-compose`,
        gpuAttestation: `${baseAttestUrl}/gpu`,
      },
      errors: result.errors || [],
    };

    res.json(response);
  } catch (err) {
    res.status(502).json({ valid: false, error: err.message, server: key });
  }
});
```

Note: `checkSecretVm` is called with `checkProofOfCloud = true` (4th argument). We use dynamic `import()` because secretvm-verify is ESM-only and our project uses CommonJS.

- [ ] **Step 2: Test the endpoint**

Run:
```bash
pkill -f "node server.js" 2>/dev/null; sleep 1; node server.js &
sleep 2
curl -s "http://localhost:3000/api/attestation?server=jedi" | head -c 500
```

Expected: JSON response with `valid`, `checks`, `links` fields. This may take 5-10 seconds as it contacts the attestation endpoints. If the server is unreachable, expect a 502 with an error message.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "Add /api/attestation endpoint

Calls secretvm-verify checkSecretVm() for the selected server and
returns structured attestation results with CPU, workload, GPU, and
ProofOfCloud verification status."
```

---

### Task 3: Add attestation badge and side panel HTML/CSS to frontend

**Files:**
- Modify: `public/index.html` (CSS in `<style>`, HTML in `<body>`)

This task adds the static structure. Task 4 adds the JavaScript behavior.

- [ ] **Step 1: Add CSS for badge, panel, and attestation items**

In `public/index.html`, add the following CSS before the closing `</style>` tag (before line 154):

```css
    /* Attestation badge */
    .tee-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #10b981;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      margin-left: auto;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .tee-badge:hover { background: rgba(16, 185, 129, 0.22); }
    .tee-badge .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
      flex-shrink: 0;
    }
    .tee-badge.loading .dot {
      background: transparent;
      border: 2px solid #10b981;
      border-top-color: transparent;
      animation: spin 0.8s linear infinite;
    }
    .tee-badge.error { border-color: rgba(239, 68, 68, 0.4); color: #ef4444; background: rgba(239, 68, 68, 0.12); }
    .tee-badge.error .dot { background: #ef4444; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Main content wrapper */
    .main-content {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    .chat-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    /* Side panel */
    .side-panel {
      width: 0;
      overflow: hidden;
      background: #22262c;
      border-left: 1px solid hsla(0,0%,100%,.1);
      transition: width 0.3s ease;
      flex-shrink: 0;
    }
    .side-panel.open { width: 380px; }
    .side-panel-inner {
      width: 380px;
      height: 100%;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .panel-header {
      padding: 20px 24px 16px;
      border-bottom: 1px solid hsla(0,0%,100%,.1);
    }
    .panel-header-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .panel-header h2 { font-size: 1.15rem; font-weight: 700; }
    .panel-close-btn {
      background: none;
      border: none;
      color: #6b6b7b;
      font-size: 1.3rem;
      cursor: pointer;
      padding: 4px 8px;
    }
    .panel-close-btn:hover { color: #a0a0b0; }
    .panel-server { font-size: 0.85rem; color: #6b6b7b; margin-top: 2px; }
    .status-banner {
      margin: 16px 24px;
      padding: 12px 16px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 0.9rem;
    }
    .status-banner.success { background: rgba(16, 185, 129, 0.1); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.25); }
    .status-banner.failure { background: rgba(239, 68, 68, 0.1); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.25); }
    .status-banner.loading { background: rgba(255,255,255,0.05); color: #a0a0b0; border: 1px solid hsla(0,0%,100%,.1); }
    .verify-btn {
      margin: 0 24px 16px;
      padding: 10px;
      background: transparent;
      border: 1px solid hsla(0,0%,100%,.1);
      border-radius: 8px;
      color: #a0a0b0;
      font-size: 0.85rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .verify-btn:hover { border-color: hsla(0,0%,100%,.2); color: #fff; }
    .attestation-list { padding: 0 24px 24px; display: flex; flex-direction: column; gap: 8px; }
    .attest-item {
      border: 1px solid hsla(0,0%,100%,.08);
      border-radius: 10px;
      overflow: hidden;
      background: #1a1a2e;
    }
    .attest-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      cursor: pointer;
    }
    .attest-header:hover { background: rgba(255,255,255,0.03); }
    .attest-icon {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.85rem;
      flex-shrink: 0;
    }
    .attest-icon.pass { background: rgba(16, 185, 129, 0.15); color: #10b981; }
    .attest-icon.fail { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
    .attest-icon.na { background: rgba(255,255,255,0.05); color: #6b6b7b; }
    .attest-title { font-weight: 600; font-size: 0.9rem; flex: 1; }
    .attest-chevron { color: #45455a; font-size: 0.8rem; transition: transform 0.2s; }
    .attest-item.expanded .attest-chevron { transform: rotate(90deg); }
    .attest-body {
      padding: 0 16px 14px 56px;
      font-size: 0.83rem;
      color: #a0a0b0;
      line-height: 1.6;
      display: none;
    }
    .attest-item.expanded .attest-body { display: block; }
    .attest-body p { margin-bottom: 8px; }
    .attest-body a { color: #34d399; text-decoration: none; font-size: 0.8rem; }
    .attest-body a:hover { text-decoration: underline; }
    .attest-detail {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .attest-detail .label { color: #6b6b7b; }
    .attest-detail .value { color: #ccc; font-family: monospace; font-size: 0.8rem; }
```

- [ ] **Step 2: Restructure the HTML body layout**

Replace the body content in `public/index.html` (lines 156-170) with this structure. The `<header>` now includes the badge, and the chat + panel are wrapped in a flex container:

```html
<body>
  <header>
    <h1>Secret AI Chat</h1>
    <select id="server-select"></select>
    <select id="model-select"></select>
    <label style="display: flex; align-items: center; gap: 6px; font-size: 0.85rem; cursor: pointer;">
      <input type="checkbox" id="think-toggle"> Thinking
    </label>
    <button id="clear-btn" style="background: #333; padding: 8px 16px; font-size: 0.85rem;">Clear</button>
    <div id="tee-badge" class="tee-badge">
      <span class="dot"></span>
      <span class="tee-text">Verified Confidential</span>
    </div>
  </header>
  <div class="main-content">
    <div class="chat-wrapper">
      <div id="chat"></div>
      <div id="input-area">
        <input type="text" id="message-input" placeholder="Type your message..." autocomplete="off">
        <button id="send-btn">Send</button>
      </div>
    </div>
    <div id="side-panel" class="side-panel">
      <div class="side-panel-inner">
        <div class="panel-header">
          <div class="panel-header-top">
            <h2>Verification Center</h2>
            <button id="panel-close" class="panel-close-btn">&times;</button>
          </div>
          <div id="panel-server" class="panel-server"></div>
        </div>
        <div id="status-banner" class="status-banner loading">Waiting...</div>
        <button id="verify-again" class="verify-btn">&#x21bb; Verify Again</button>
        <div id="attestation-list" class="attestation-list"></div>
      </div>
    </div>
  </div>
```

- [ ] **Step 3: Verify the page loads without errors**

Run:
```bash
pkill -f "node server.js" 2>/dev/null; sleep 1; node server.js &
sleep 2
curl -s http://localhost:3000 | grep -c "tee-badge"
```

Expected: `1` (confirms the badge HTML is present).

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "Add attestation panel HTML structure and CSS

Add Verified Confidential badge to header, collapsible side panel
with status banner, verify button, and attestation item containers.
Green color scheme using emerald #10b981."
```

---

### Task 4: Add frontend JavaScript for attestation panel behavior

**Files:**
- Modify: `public/index.html` (inside `<script>` block)

- [ ] **Step 1: Add attestation panel JavaScript**

In `public/index.html`, add the following code at the end of the `<script>` block, just before the closing `</script>` tag (before line 339 in original):

```js
    // --- Attestation panel ---
    const teeBadge = document.getElementById("tee-badge");
    const sidePanel = document.getElementById("side-panel");
    const panelClose = document.getElementById("panel-close");
    const panelServer = document.getElementById("panel-server");
    const statusBanner = document.getElementById("status-banner");
    const attestList = document.getElementById("attestation-list");
    const verifyAgainBtn = document.getElementById("verify-again");

    let panelOpen = false;

    function togglePanel() {
      panelOpen = !panelOpen;
      sidePanel.classList.toggle("open", panelOpen);
    }
    teeBadge.addEventListener("click", togglePanel);
    panelClose.addEventListener("click", togglePanel);

    function renderAttestItem(title, description, passed, details, link) {
      const stateClass = passed === true ? "pass" : passed === false ? "fail" : "na";
      const icon = passed === true ? "\u2713" : passed === false ? "\u2717" : "\u2014";
      const detailsHtml = details
        .filter(d => d.value != null)
        .map(d => `<div class="attest-detail"><span class="label">${d.label}</span><span class="value">${d.value}</span></div>`)
        .join("");
      const linkHtml = link ? `<div style="margin-top:10px"><a href="${link.url}" target="_blank">\u2197 ${link.text}</a></div>` : "";

      return `<div class="attest-item">
        <div class="attest-header" onclick="this.parentElement.classList.toggle('expanded')">
          <div class="attest-icon ${stateClass}">${icon}</div>
          <div class="attest-title">${title}</div>
          <span class="attest-chevron">\u25B6</span>
        </div>
        <div class="attest-body">
          <p>${description}</p>
          ${detailsHtml}
          ${linkHtml}
        </div>
      </div>`;
    }

    function renderAttestation(data) {
      if (data.error && !data.checks) {
        statusBanner.className = "status-banner failure";
        statusBanner.textContent = "\u2717 " + (data.error || "Verification failed");
        attestList.innerHTML = "";
        return;
      }

      const allPassed = data.valid;
      statusBanner.className = `status-banner ${allPassed ? "success" : "failure"}`;
      statusBanner.textContent = allPassed ? "\u2713 All checks passed" : "\u2717 Some checks failed";

      const c = data.checks;
      const l = data.links;

      attestList.innerHTML = [
        renderAttestItem(
          `Genuine ${c.cpu.platform || "TEE"} Machine`,
          "This server runs inside a genuine trusted execution environment. The CPU attestation quote has been cryptographically verified against the hardware vendor's root of trust.",
          c.cpu.passed,
          [
            { label: "Platform", value: c.cpu.platform },
            { label: "TCB Status", value: c.cpu.tcbStatus },
            { label: "MRTD", value: c.cpu.mrtd },
          ],
          { url: l.cpuQuote, text: "View raw attestation quote" }
        ),
        renderAttestItem(
          "Verified Workload",
          "The software running inside this TEE matches the expected, publicly auditable configuration. No unauthorized code modifications detected.",
          c.workload.passed,
          [
            { label: "Status", value: c.workload.status },
            { label: "Template", value: c.workload.templateName },
          ],
          { url: l.dockerCompose, text: "View docker-compose" }
        ),
        renderAttestItem(
          "GPU Attestation",
          "The NVIDIA GPU has been verified through NVIDIA's Remote Attestation Service. Secure boot is active and all firmware measurements are valid.",
          c.gpu.passed,
          [
            { label: "GPU Model", value: c.gpu.model },
            { label: "Secure Boot", value: c.gpu.secureBoot === true ? "Enabled" : c.gpu.secureBoot === false ? "Disabled" : null },
          ],
          { url: l.gpuAttestation, text: "View GPU attestation report" }
        ),
        renderAttestItem(
          "Proof of Cloud",
          "The machine's identity has been validated against a known cloud provider. This confirms the server is running on legitimate infrastructure, not a simulated environment.",
          c.proofOfCloud.passed,
          [],
          null
        ),
      ].join("");
    }

    function setBadgeState(state) {
      teeBadge.className = "tee-badge" + (state === "loading" ? " loading" : state === "error" ? " error" : "");
      const textEl = teeBadge.querySelector(".tee-text");
      if (state === "loading") textEl.textContent = "Verifying...";
      else if (state === "error") textEl.textContent = "Verification Failed";
      else textEl.textContent = "Verified Confidential";
    }

    async function runAttestation() {
      const server = serverSelect.value;
      if (!server) return;

      setBadgeState("loading");
      statusBanner.className = "status-banner loading";
      statusBanner.textContent = "Verifying...";
      attestList.innerHTML = "";
      panelServer.textContent = server;

      try {
        const res = await fetch(`/api/attestation?server=${server}`);
        const data = await res.json();
        setBadgeState(data.valid ? "success" : "error");
        renderAttestation(data);
      } catch (err) {
        setBadgeState("error");
        renderAttestation({ error: err.message });
      }
    }

    // Fire on page load and server change
    serverSelect.addEventListener("change", runAttestation);
    // Run after servers are loaded (modify the existing fetch chain)
```

- [ ] **Step 2: Hook attestation into server load**

Find the existing server-load fetch chain in the script (around line 203-213 in original). Replace:

```js
    fetch("/api/servers")
      .then((r) => r.json())
      .then((servers) => {
        servers.forEach((s) => {
          const opt = document.createElement("option");
          opt.value = s;
          opt.textContent = s;
          serverSelect.appendChild(opt);
        });
        loadModels();
      });
```

With:

```js
    fetch("/api/servers")
      .then((r) => r.json())
      .then((servers) => {
        servers.forEach((s) => {
          const opt = document.createElement("option");
          opt.value = s;
          opt.textContent = s;
          serverSelect.appendChild(opt);
        });
        loadModels();
        runAttestation();
      });
```

Note: `runAttestation` is defined later in the script but this is fine because the fetch `.then()` callback runs asynchronously after the entire script has been parsed.

- [ ] **Step 3: Wire up the Verify Again button**

This is already handled — `verifyAgainBtn` is declared in Step 1. Add this line right after the `serverSelect.addEventListener("change", runAttestation);` line:

```js
    verifyAgainBtn.addEventListener("click", runAttestation);
```

- [ ] **Step 4: Test end-to-end in browser**

Run:
```bash
pkill -f "node server.js" 2>/dev/null; sleep 1; node server.js &
```

Open `http://localhost:3000` in a browser. Verify:
1. "Verifying..." badge appears with spinner
2. After a few seconds, badge turns green or red
3. Clicking badge opens the side panel
4. Panel shows server name, status banner, and 4 attestation items
5. Clicking an item expands it to show details and links
6. "Verify Again" re-runs the verification
7. Switching servers triggers a new verification

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Add attestation panel JavaScript behavior

Wire up badge toggle, async verification on server change,
expandable attestation items, and Verify Again button."
```

---

### Task 5: Integration test and polish

**Files:**
- Modify: `server.js` (minor adjustments if needed based on actual SDK response shape)
- Modify: `public/index.html` (minor adjustments if needed)

- [ ] **Step 1: Test with each server**

Open `http://localhost:3000` and test each server (prod, lambda, jedi):
1. Select each server from the dropdown
2. Confirm attestation runs and results display
3. Note any fields that come back `null` — these indicate the SDK response shape differs from what we assumed in Task 2

- [ ] **Step 2: Adjust field extraction if needed**

If the SDK returns fields under different property names than assumed, update the field extraction in the `/api/attestation` endpoint in `server.js`. Common adjustments:
- CPU platform type might be in `result.report.tee_type` instead of `result.report.cpu_type`
- MRTD might be in `result.report.mrtd` instead of `result.report.mr_td`
- GPU model might be nested differently in the report

To debug, temporarily log the full result:
```js
console.log(JSON.stringify(result, null, 2));
```

- [ ] **Step 3: Test panel interaction alongside chat**

1. Open panel, send a chat message — confirm chat still works with panel open
2. Close panel, send a message — confirm layout returns to normal
3. Switch servers while panel is open — confirm panel updates

- [ ] **Step 4: Commit final version**

```bash
git add server.js public/index.html
git commit -m "Polish attestation panel integration

Adjust SDK field extraction based on actual response shape.
Verify panel works alongside chat for all servers."
```
