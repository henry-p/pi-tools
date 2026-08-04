#!/usr/bin/env node

import http from "node:http";

// crypto.randomUUID() is unavailable on non-localhost HTTP origins because they
// are not secure contexts. The upstream live bundle currently calls it during
// startup, before it can render controls or connect its event stream. Keep the
// Tailnet HTTP transport usable by installing the narrow missing API first.
const INSECURE_CONTEXT_UUID_POLYFILL = `
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value() {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
      return [hex.slice(0, 4).join(""), hex.slice(4, 6).join(""), hex.slice(6, 8).join(""), hex.slice(8, 10).join(""), hex.slice(10).join("")].join("-");
    },
  });
}
`;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const host = option("--listen", "127.0.0.1");
const publicHost = option("--public-host", host);
const targetPort = Number(option("--target-port"));
if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
  console.error("--target-port must be an integer between 1 and 65535");
  process.exit(2);
}

let publicOrigin;

const server = http.createServer((request, response) => {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: targetPort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${targetPort}` },
    },
    (upstreamResponse) => {
      if (request.url?.startsWith("/live.js")) {
        const chunks = [];
        upstreamResponse.on("data", (chunk) => chunks.push(chunk));
        upstreamResponse.on("end", () => {
          const publicPort = new URL(publicOrigin).port;
          const body = INSECURE_CONTEXT_UUID_POLYFILL + Buffer.concat(chunks)
            .toString("utf8")
            .replaceAll(`http://localhost:${targetPort}`, publicOrigin)
            .replaceAll(`http://127.0.0.1:${targetPort}`, publicOrigin)
            // The live bundle builds its API URLs from the injected port at
            // runtime, so rewrite those URLs for a non-loopback browser too.
            .replaceAll(`window.__IMPECCABLE_PORT__ = ${targetPort};`, `window.__IMPECCABLE_PORT__ = ${publicPort};`)
            .replaceAll("'http://localhost:' + PORT", JSON.stringify(publicOrigin))
            .replaceAll('"http://localhost:" + PORT', JSON.stringify(publicOrigin))
            .replaceAll("http://localhost:${PORT}", publicOrigin);
          const headers = { ...upstreamResponse.headers };
          delete headers["content-length"];
          delete headers["content-encoding"];
          delete headers.etag;
          headers["content-length"] = Buffer.byteLength(body);
          response.writeHead(upstreamResponse.statusCode || 502, headers);
          response.end(body);
        });
        return;
      }
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end(`Tailscale live proxy error: ${error.message}`);
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
});

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

server.listen(0, host, () => {
  const address = server.address();
  publicOrigin = `http://${publicHost}:${address.port}`;
  console.log(JSON.stringify({ ready: true, host, publicHost, port: address.port, targetPort }));
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
