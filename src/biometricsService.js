const { decryptText, encryptText } = require("./security");
const { db } = require("./database");

const scannerUrl = process.env.BYTEZONE_SCANNER_URL ? new URL(process.env.BYTEZONE_SCANNER_URL) : null;
if (scannerUrl && scannerUrl.protocol !== "https:" && scannerUrl.hostname !== "localhost" && scannerUrl.hostname !== "127.0.0.1") {
  throw new Error("BYTEZONE_SCANNER_URL must use HTTPS except for a local scanner bridge.");
}
if (scannerUrl && !process.env.BYTEZONE_SCANNER_TOKEN) {
  throw new Error("BYTEZONE_SCANNER_TOKEN is required when a scanner bridge is configured.");
}

async function scannerRequest(path, body) {
  if (!scannerUrl) return { available: false };
  const url = new URL(path, scannerUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        ...(process.env.BYTEZONE_SCANNER_TOKEN ? { authorization: `Bearer ${process.env.BYTEZONE_SCANNER_TOKEN}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 503 || response.status === 404) return { available: false };
      throw new Error(`Scanner bridge returned HTTP ${response.status}.`);
    }
    return { available: true, result: await response.json() };
  } catch (error) {
    if (error.name === "AbortError" || error.cause?.code === "ECONNREFUSED" || error.cause?.code === "ENOTFOUND") {
      return { available: false };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function scannerStatus() {
  const response = await scannerRequest("/health");
  return response.available;
}

async function enroll(userId) {
  const response = await scannerRequest("/enroll", { subjectId: userId });
  if (!response.available) return { available: false };
  const template = response.result?.template;
  if (typeof template !== "string" || !/^[A-Za-z\d+/]+=*$/.test(template) || template.length > 200000) {
    throw new Error("Scanner bridge returned an invalid fingerprint template.");
  }
  const bytes = Buffer.from(template, "base64");
  if (bytes.length < 16) throw new Error("Scanner bridge returned an empty fingerprint template.");
  db.prepare("UPDATE users SET biometric_template = ? WHERE id = ?").run(encryptText(template), userId);
  return { available: true };
}

async function verify(userId) {
  const row = db.prepare("SELECT biometric_template FROM users WHERE id = ?").get(userId);
  if (!row?.biometric_template) return { available: true, enrolled: false, matched: false };
  const response = await scannerRequest("/verify", {
    subjectId: userId,
    template: decryptText(row.biometric_template),
  });
  if (!response.available) return { available: false, enrolled: true, matched: false };
  return { available: true, enrolled: true, matched: response.result?.matched === true };
}

function isEnrolled(userId) {
  return Boolean(db.prepare("SELECT biometric_template FROM users WHERE id = ?").get(userId)?.biometric_template);
}

module.exports = { enroll, isEnrolled, scannerStatus, verify };
