const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { decryptBuffer, encryptBuffer } = require("./security");

const vaultDirectory = path.resolve(process.env.BYTEZONE_VAULT_PATH || "./storage/vault");

async function initializeVault() {
  await fs.mkdir(vaultDirectory, { recursive: true, mode: 0o700 });
}

async function storeFile(buffer) {
  await initializeVault();
  const id = crypto.randomUUID();
  const filePath = path.join(vaultDirectory, `${id}.vault`);
  await fs.writeFile(filePath, encryptBuffer(buffer), { flag: "wx", mode: 0o600 });
  return { id, filePath };
}

async function readFile(id) {
  if (!/^[\da-f-]{36}$/i.test(id)) throw new Error("Invalid vault file identifier.");
  const filePath = path.join(vaultDirectory, `${id}.vault`);
  return decryptBuffer(await fs.readFile(filePath));
}

async function removeFile(id) {
  if (!/^[\da-f-]{36}$/i.test(id)) throw new Error("Invalid vault file identifier.");
  await fs.unlink(path.join(vaultDirectory, `${id}.vault`));
}

module.exports = { initializeVault, readFile, removeFile, storeFile };
