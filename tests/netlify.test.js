const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { handler } = require("../netlify/functions/backend");

test("Netlify backend proxy forwards portal paths, cookies, CSRF headers, and binary request bodies", async (t) => {
  const requests = [];
  const backend = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        secret: request.headers["x-bytezone-proxy-secret"],
        cookie: request.headers.cookie,
        csrf: request.headers["x-csrf-token"],
        host: request.headers.host,
        body: Buffer.concat(chunks),
      });
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", ["bzsession=secret; HttpOnly", "bzcsrf=token"]);
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => backend.close((error) => error ? reject(error) : resolve())));

  const originalBackend = process.env.BYTEZONE_BACKEND_URL;
  const originalSecret = process.env.BYTEZONE_PROXY_SECRET;
  process.env.BYTEZONE_BACKEND_URL = `http://127.0.0.1:${backend.address().port}`;
  process.env.BYTEZONE_PROXY_SECRET = "test-proxy-secret-with-more-than-32-characters";
  t.after(() => {
    if (originalBackend === undefined) delete process.env.BYTEZONE_BACKEND_URL;
    else process.env.BYTEZONE_BACKEND_URL = originalBackend;
    if (originalSecret === undefined) delete process.env.BYTEZONE_PROXY_SECRET;
    else process.env.BYTEZONE_PROXY_SECRET = originalSecret;
  });

  const getResponse = await handler({
    path: "/.netlify/functions/backend/api/health",
    rawUrl: "https://bytezone.example/.netlify/functions/backend/api/health?check=1",
    httpMethod: "GET",
    headers: {
      host: "bytezone.example",
      cookie: "bzcsrf=test-cookie",
      "x-csrf-token": "test-token",
      "x-bytezone-proxy-secret": "untrusted-value",
    },
  });

  assert.equal(getResponse.statusCode, 200);
  assert.deepEqual(getResponse.multiValueHeaders["set-cookie"], ["bzsession=secret; HttpOnly", "bzcsrf=token"]);
  assert.deepEqual(requests[0], {
    path: "/api/health?check=1",
    secret: process.env.BYTEZONE_PROXY_SECRET,
    cookie: "bzcsrf=test-cookie",
    csrf: "test-token",
    host: `127.0.0.1:${backend.address().port}`,
    body: Buffer.alloc(0),
  });

  const upload = Buffer.from([0, 1, 2, 255]);
  const postResponse = await handler({
    path: "/.netlify/functions/backend/api/upload",
    rawUrl: "https://bytezone.example/.netlify/functions/backend/api/upload",
    httpMethod: "POST",
    isBase64Encoded: true,
    body: upload.toString("base64"),
    headers: { "content-type": "application/octet-stream" },
  });

  assert.equal(postResponse.statusCode, 200);
  assert.deepEqual(requests[1].body, upload);
  assert.equal(requests[1].path, "/api/upload");
});

test("Netlify backend proxy rejects missing configuration and paths outside the application", async (t) => {
  const originalBackend = process.env.BYTEZONE_BACKEND_URL;
  const originalSecret = process.env.BYTEZONE_PROXY_SECRET;
  t.after(() => {
    if (originalBackend === undefined) delete process.env.BYTEZONE_BACKEND_URL;
    else process.env.BYTEZONE_BACKEND_URL = originalBackend;
    if (originalSecret === undefined) delete process.env.BYTEZONE_PROXY_SECRET;
    else process.env.BYTEZONE_PROXY_SECRET = originalSecret;
  });

  delete process.env.BYTEZONE_BACKEND_URL;
  delete process.env.BYTEZONE_PROXY_SECRET;
  const unconfigured = await handler({ path: "/.netlify/functions/backend/ops", httpMethod: "GET" });
  assert.equal(unconfigured.statusCode, 503);

  process.env.BYTEZONE_BACKEND_URL = "https://backend.example";
  process.env.BYTEZONE_PROXY_SECRET = "test-proxy-secret-with-more-than-32-characters";
  const forbiddenPath = await handler({
    path: "/.netlify/functions/backend/src/security.js",
    httpMethod: "GET",
  });
  assert.equal(forbiddenPath.statusCode, 404);
});
