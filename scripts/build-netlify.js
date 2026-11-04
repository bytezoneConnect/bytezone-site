const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
fs.mkdirSync(output, { recursive: true });

for (const file of ["index.html", "sitemap.xml", "googlea569bbac5b256e52.html"]) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}

for (const file of ["operations.html", "operations.js"]) {
  fs.copyFileSync(path.join(root, "public", file), path.join(output, file));
}

fs.copyFileSync(path.join(root, "public", "app.css"), path.join(output, "app.css"));
fs.cpSync(path.join(root, "images"), path.join(output, "images"), { recursive: true });
