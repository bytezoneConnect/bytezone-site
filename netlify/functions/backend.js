const BACKEND_PREFIX = "/.netlify/functions/backend";
const ALLOWED_PATHS = ["/ops", "/operations.html", "/operations.js", "/app.css", "/api"];
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function getTargetPath(event) {
  const parsedUrl = new URL(event.rawUrl || `https://netlify.invalid${event.path}`);
  const eventPath = new URL(event.path || "/", "https://netlify.invalid").pathname;
  const targetPath = eventPath.startsWith(`${BACKEND_PREFIX}/`)
    ? `/${eventPath.slice(BACKEND_PREFIX.length + 1)}`
    : eventPath;
  if (!ALLOWED_PATHS.some((allowed) => targetPath === allowed || targetPath.startsWith(`${allowed}/`))) return null;
  return `${targetPath}${parsedUrl.search}`;
}

function readResponseHeaders(response) {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "set-cookie") {
      headers[name] = value;
    }
  }
  const cookies = response.headers.getSetCookie?.() || [];
  return { headers, cookies };
}

exports.handler = async (event) => {
  const backendUrl = process.env.BYTEZONE_BACKEND_URL;
  const proxySecret = process.env.BYTEZONE_PROXY_SECRET;
  if (!backendUrl || !proxySecret) {
    return {
      statusCode: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ error: "ByteZone portal backend is not configured. Contact the site administrator." }),
    };
  }

  let base;
  try {
    base = new URL(backendUrl);
  } catch {
    return {
      statusCode: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ error: "ByteZone portal backend has an invalid configuration." }),
    };
  }
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) {
    return {
      statusCode: 503,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ error: "ByteZone portal backend must use HTTPS." }),
    };
  }

  const targetPath = getTargetPath(event);
  if (!targetPath) {
    return { statusCode: 404, headers: { "cache-control": "no-store" }, body: "Not Found" };
  }

  const target = new URL(targetPath, base);
  const requestHeaders = new Headers();
  for (const [name, value] of Object.entries(event.headers || {})) {
    const normalizedName = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(normalizedName) && normalizedName !== "x-bytezone-proxy-secret" && typeof value === "string") {
      requestHeaders.set(normalizedName, value);
    }
  }
  requestHeaders.set("x-bytezone-proxy-secret", proxySecret);

  const method = event.httpMethod || "GET";
  const body = ["GET", "HEAD"].includes(method.toUpperCase())
    ? undefined
    : event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : event.body;

  try {
    const upstream = await fetch(target, {
      method,
      headers: requestHeaders,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
    });
    const { headers, cookies } = readResponseHeaders(upstream);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type") || "";
    const isText = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded))/.test(contentType)
      || contentType.includes("svg+xml");
    const response = {
      statusCode: upstream.status,
      headers: { ...headers, "cache-control": "no-store" },
      body: isText ? bytes.toString("utf8") : bytes.toString("base64"),
      isBase64Encoded: !isText,
    };
    if (cookies.length) response.multiValueHeaders = { "set-cookie": cookies };
    return response;
  } catch {
    return {
      statusCode: 502,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ error: "ByteZone portal backend is unavailable. Try again later." }),
    };
  }
};
