require("dotenv").config();
const { migrate } = require("../src/database");

migrate().then(() => {
  console.log("Database migrations applied.");
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
