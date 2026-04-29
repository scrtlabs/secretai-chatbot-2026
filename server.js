require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require("express");
const https = require("https");
const path = require("path");

const app = express();
const PORT = 3000;

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

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/servers", (_req, res) => {
  res.json(Object.keys(SERVERS));
});

app.get("/api/models", (req, res) => {
  const baseUrl = getOllamaUrl(req);
  const url = new URL(`${baseUrl}/api/tags`);
  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "GET",
    headers: { Authorization: `Basic ${API_KEY}` },
  };
  const proxyReq = https.request(options, (proxyRes) => {
    let data = "";
    proxyRes.on("data", (chunk) => (data += chunk));
    proxyRes.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        const models = parsed.models.map((m) => m.name);
        res.json(models);
      } catch {
        res.status(502).json([]);
      }
    });
  });
  proxyReq.on("error", () => res.status(502).json([]));
  proxyReq.end();
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

    const baseUrl = getOllamaUrl(req);
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

app.listen(PORT, () => {
  console.log(`Secret AI Chat running at http://localhost:${PORT}`);
});
