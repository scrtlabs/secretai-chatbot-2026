require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require("express");
const https = require("https");
const path = require("path");

const app = express();
const PORT = 3000;
const ATTEST_PORT = 29343;

// Hoist ESM import — secretvm-verify is ESM-only, cache it at startup
let checkSecretVm;
import("secretvm-verify").then((m) => { checkSecretVm = m.checkSecretVm; });

const SERVERS = {
  prod:   { url: "https://67.215.13.123:21434",              attestHost: "secretai-rytn.scrtlabs.com" },
  lambda: { url: "https://192.222.55.202:21434",             attestHost: "secretai-yyzz.scrtlabs.com" },
  jedi:   { url: "https://secretai-jedi.scrtlabs.com:21434", attestHost: "secretai-jedi.scrtlabs.com" },
};

// EXTRA_SERVERS: comma-separated URLs added at startup
(process.env.EXTRA_SERVERS || "").split(",").map(s => s.trim()).filter(Boolean).forEach((urlStr, i) => {
  try {
    const u = new URL(urlStr);
    SERVERS[`extra-${i + 1}`] = { url: urlStr, attestHost: u.hostname };
  } catch {
    console.warn(`Skipping invalid EXTRA_SERVERS entry: ${urlStr}`);
  }
});

const ENABLED_SERVERS = (process.env.SERVERS
  ? process.env.SERVERS.split(",").map(s => s.trim()).filter(s => SERVERS[s])
  : Object.keys(SERVERS));
if (process.env.EXTRA_SERVERS) {
  for (const k of Object.keys(SERVERS)) {
    if (k.startsWith("extra-") && !ENABLED_SERVERS.includes(k)) ENABLED_SERVERS.push(k);
  }
}
const DEFAULT_SERVER = ENABLED_SERVERS[0] || "prod";
const API_KEY = process.env.API_KEY || "";

// model → server key mapping, built on startup
let modelServerMap = {};

function fetchModelsFromServer(serverKey) {
  const server = SERVERS[serverKey];
  if (!server) return Promise.resolve([]);
  const url = new URL(`${server.url}/api/tags`);
  return new Promise((resolve) => {
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: { Authorization: `Basic ${API_KEY}` },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.models.map((m) => m.name));
        } catch {
          resolve([]);
        }
      });
    });
    req.on("error", () => resolve([]));
    req.end();
  });
}

async function buildModelMap() {
  const map = {};
  for (const key of ENABLED_SERVERS) {
    const models = await fetchModelsFromServer(key);
    for (const model of models) {
      if (!map[model]) map[model] = key;
    }
  }
  modelServerMap = map;
  console.log(`Discovered ${Object.keys(map).length} models across ${ENABLED_SERVERS.length} servers`);
  return map;
}

function getServerForModel(model) {
  return modelServerMap[model] || DEFAULT_SERVER;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/models", async (_req, res) => {
  await buildModelMap();
  const models = Object.entries(modelServerMap).map(([name, server]) => ({ name, server }));
  res.json(models);
});

function fetchModelsFromUrl(urlStr) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(`${urlStr.replace(/\/$/, "")}/api/tags`); } catch { return resolve([]); }
    const lib = url.protocol === "http:" ? require("http") : https;
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: { Authorization: `Basic ${API_KEY}` },
    };
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data).models.map((m) => m.name)); } catch { resolve([]); }
      });
    });
    req.on("error", () => resolve([]));
    req.end();
  });
}

app.get("/api/proxy-models", async (req, res) => {
  const urlStr = req.query.url;
  if (!urlStr || !/^https?:\/\//.test(urlStr)) {
    return res.status(400).json({ error: "Invalid URL — must be http:// or https://" });
  }
  const models = await fetchModelsFromUrl(urlStr);
  res.json(models);
});

app.get("/api/attestation", async (req, res) => {
  let server, key;
  if (req.query.host) {
    server = { url: null, attestHost: req.query.host };
    key = req.query.host;
  } else {
    key = req.query.server || (req.query.model ? getServerForModel(req.query.model) : DEFAULT_SERVER);
    server = SERVERS[key];
  }
  if (!server) {
    return res.status(400).json({ valid: false, error: "Unknown server" });
  }

  try {
    // checkSecretVm(host, product, reloadAmdKds, checkProofOfCloud)
    const result = await checkSecretVm(server.attestHost, "", false, true);

    const baseAttestUrl = `https://${server.attestHost}:${ATTEST_PORT}`;

    // Overall validity excludes proof_of_cloud (advisory) and absent GPU checks.
    // A check counts as failed only if explicitly false; missing == not applicable.
    const coreChecks = [
      result.checks.cpu_quote_verified,
      result.checks.tls_binding_verified,
      result.checks.workload_binding_verified,
      result.checks.gpu_quote_verified,
      result.checks.gpu_binding_verified,
    ];
    const valid = coreChecks.every((c) => c !== false);

    const response = {
      valid,
      server: key,
      attestHost: server.attestHost,
      attestationType: result.attestationType || "Unknown",
      checks: {
        cpu: {
          passed: result.checks.cpu_quote_verified ?? null,
          platform: ({ "TDX": "Intel TDX", "SEV-SNP": "AMD SEV-SNP" })[result.report.cpu_type] || result.report.cpu_type || "Unknown",
          product: result.report.cpu?.product || null,
          measurement: result.report.cpu?.measurement
            ? (result.report.cpu.measurement.substring(0, 8) + "..." + result.report.cpu.measurement.slice(-4))
            : null,
        },
        workload: {
          passed: result.checks.workload_binding_verified ?? null,
          status: result.report.workload?.status || null,
          templateName: result.report.workload?.template_name || null,
        },
        tlsBinding: {
          passed: result.checks.tls_binding_verified ?? null,
          fingerprint: result.report.tls_fingerprint
            ? (result.report.tls_fingerprint.substring(0, 8) + "..." + result.report.tls_fingerprint.slice(-4))
            : null,
        },
        gpu: (() => {
          const gpus = result.report.gpu?.gpus;
          const firstGpu = gpus ? Object.values(gpus)[0] : null;
          const present = "gpu_quote_verified" in result.checks;
          return {
            present,
            passed: result.checks.gpu_quote_verified ?? null,
            cpuBound: result.checks.gpu_binding_verified ?? null,
            model: firstGpu?.model || null,
            secureBoot: firstGpu?.secure_boot ?? null,
          };
        })(),
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

app.post("/api/chat", async (req, res) => {
  const { model, messages, think, serverUrl } = req.body;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders();

  try {
    const controller = new AbortController();
    res.on("close", () => controller.abort());

    let baseUrl;
    if (serverUrl && /^https?:\/\//.test(serverUrl)) {
      baseUrl = serverUrl;
    } else {
      const serverKey = getServerForModel(model);
      baseUrl = SERVERS[serverKey]?.url || SERVERS[DEFAULT_SERVER].url;
    }
    const upstream = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, stream: true, think: !!think }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      res.write(`data: ${JSON.stringify({ error: `Upstream error: ${upstream.status}` })}\n\n`);
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const content = parsed?.message?.content || "";
          const thinking = parsed?.message?.thinking || "";
          if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
          if (thinking) res.write(`data: ${JSON.stringify({ thinking })}\n\n`);
          if (parsed.done) {
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        } catch {}
      }
    }

    if (!res.writableEnded) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
    if (!res.writableEnded) res.end();
  }
});

app.listen(PORT, async () => {
  console.log(`Secret AI Chat running at http://localhost:${PORT}`);
  console.log(`Enabled servers: ${ENABLED_SERVERS.join(", ")}`);
  await buildModelMap();
});
