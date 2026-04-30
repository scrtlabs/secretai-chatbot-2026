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
const ENABLED_SERVERS = (process.env.SERVERS || Object.keys(SERVERS).join(","))
  .split(",").map(s => s.trim()).filter(s => SERVERS[s]);
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
  if (Object.keys(modelServerMap).length === 0) {
    await buildModelMap();
  }
  const models = Object.entries(modelServerMap).map(([name, server]) => ({ name, server }));
  res.json(models);
});

app.get("/api/attestation", async (req, res) => {
  const key = req.query.server || (req.query.model ? getServerForModel(req.query.model) : DEFAULT_SERVER);
  const server = SERVERS[key];
  if (!server) {
    return res.status(400).json({ valid: false, error: "Unknown server" });
  }

  try {
    // checkSecretVm(host, product, reloadAmdKds, checkProofOfCloud)
    const result = await checkSecretVm(server.attestHost, "", false, true);

    const baseAttestUrl = `https://${server.attestHost}:${ATTEST_PORT}`;

    const response = {
      valid: result.valid,
      server: key,
      attestHost: server.attestHost,
      attestationType: result.attestationType || "Unknown",
      checks: {
        cpu: {
          passed: result.checks.cpu_quote_verified ?? null,
          platform: result.report.cpu_type || "Unknown",
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
          return {
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
  const { model, messages, think } = req.body;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders();

  try {
    const controller = new AbortController();
    res.on("close", () => controller.abort());

    const serverKey = getServerForModel(model);
    const baseUrl = SERVERS[serverKey]?.url || SERVERS[DEFAULT_SERVER].url;
    const upstream = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, stream: true, ...(think && { think: true }) }),
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
