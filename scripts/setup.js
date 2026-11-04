require("dotenv").config();
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
const templatePath = path.join(root, ".env.example");

if (fs.existsSync(envPath)) {
  console.log(".env already exists; leaving your configuration unchanged.");
  process.exit(0);
}

const template = fs.readFileSync(templatePath, "utf8");
if (!/^BYTEZONE_ENCRYPTION_KEY=$/m.test(template)) {
  throw new Error(".env.example must contain an empty BYTEZONE_ENCRYPTION_KEY setting.");
}

const key = crypto.randomBytes(32).toString("hex");
const configuration = template.replace(/^BYTEZONE_ENCRYPTION_KEY=$/m, `BYTEZONE_ENCRYPTION_KEY=${key}`);
fs.writeFileSync(envPath, configuration, { flag: "wx", mode: 0o600 });
console.log("Created .env with a new encryption key. Back it up securely; never commit or replace it.");
