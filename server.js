require("dotenv").config();
const { app } = require("./src/app");
const { migrate } = require("./src/database");
const { initializeVault } = require("./src/vault");

async function start() {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.BYTEZONE_PROXY_SECRET || process.env.BYTEZONE_PROXY_SECRET.length < 32) {
      throw new Error("Production requires a 32-character BYTEZONE_PROXY_SECRET shared with Netlify.");
    }
    const configuredPublicOrigin = process.env.BYTEZONE_PUBLIC_ORIGIN || "";
    let publicOrigin;
    try {
      publicOrigin = new URL(configuredPublicOrigin);
    } catch {
      throw new Error("Production requires BYTEZONE_PUBLIC_ORIGIN set to the exact HTTPS site origin without a trailing slash.");
    }
    if (publicOrigin.protocol !== "https:" || publicOrigin.origin !== configuredPublicOrigin) {
      throw new Error("Production requires BYTEZONE_PUBLIC_ORIGIN set to the exact HTTPS site origin without a trailing slash.");
    }
  }
  await migrate();
  await initializeVault();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`ByteZone operations server listening on port ${port}`));
}

start().catch((error) => {
  console.error("ByteZone server failed to start:", error.message);
  process.exitCode = 1;
});
