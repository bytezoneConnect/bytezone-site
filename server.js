require("dotenv").config();
const { app } = require("./src/app");
const { migrate } = require("./src/database");
const { initializeVault } = require("./src/vault");

async function start() {
  await migrate();
  await initializeVault();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`ByteZone operations server listening on port ${port}`));
}

start().catch((error) => {
  console.error("ByteZone server failed to start:", error.message);
  process.exitCode = 1;
});
