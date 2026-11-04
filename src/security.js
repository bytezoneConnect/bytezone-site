const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const configuredKey = process.env.BYTEZONE_ENCRYPTION_KEY || "";
if (!/^[\da-fA-F]{64}$/.test(configuredKey)) {
  throw new Error("BYTEZONE_ENCRYPTION_KEY must be configured as 64 hexadecimal characters (32 bytes).");
}

const masterKey = Buffer.from(configuredKey, "hex");
const encryptionKey = Buffer.from(crypto.hkdfSync("sha256", masterKey, Buffer.from("bytezone"), Buffer.from("aes-256-gcm"), 32));
const digestKey = Buffer.from(crypto.hkdfSync("sha256", masterKey, Buffer.from("bytezone"), Buffer.from("lookup-hmac"), 32));

function encryptBuffer(value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function decryptBuffer(value) {
  if (value.length < 28) throw new Error("Encrypted data is truncated.");
  const nonce = value.subarray(0, 12);
  const tag = value.subarray(12, 28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
}

function encryptText(value) {
  return encryptBuffer(Buffer.from(value, "utf8")).toString("base64");
}

function decryptText(value) {
  return decryptBuffer(Buffer.from(value, "base64")).toString("utf8");
}

function encryptJson(value) {
  return encryptText(JSON.stringify(value));
}

function decryptJson(value) {
  return JSON.parse(decryptText(value));
}

function digest(value) {
  return crypto.createHmac("sha256", digestKey).update(value).digest("hex");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString("hex")}$${Buffer.from(derived).toString("hex")}`;
}

async function verifyPassword(password, savedHash) {
  const [algorithm, saltHex, expectedHex] = savedHash.split("$");
  if (algorithm !== "scrypt" || !/^[\da-f]{32}$/.test(saltHex) || !/^[\da-f]{128}$/.test(expectedHex)) return false;
  const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  const expected = Buffer.from(expectedHex, "hex");
  return crypto.timingSafeEqual(actual, expected);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

module.exports = {
  decryptBuffer,
  decryptJson,
  decryptText,
  digest,
  encryptBuffer,
  encryptJson,
  encryptText,
  hashPassword,
  normalizeEmail,
  verifyPassword,
};
