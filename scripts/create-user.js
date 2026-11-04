require("dotenv").config();
const prompts = require("prompts");
const { migrate } = require("../src/database");
const { createUser } = require("../src/app");

async function main() {
  await migrate();
  const answers = await prompts([
    { type: "text", name: "email", message: "Email", validate: (value) => value.trim() ? true : "Email is required." },
    { type: "text", name: "name", message: "Name", validate: (value) => value.trim() ? true : "Name is required." },
    { type: "text", name: "phone", message: "Phone (optional)" },
    { type: "select", name: "role", message: "Role", choices: [{ title: "Admin", value: "admin" }, { title: "Staff", value: "staff" }] },
    { type: "password", name: "password", message: "Password (12+ characters)", validate: (value) => value.length >= 12 ? true : "Use at least 12 characters." },
  ], {
    onCancel: () => { throw new Error("Account creation cancelled."); },
  });
  if (!answers.email || !answers.name || !answers.role || !answers.password) throw new Error("Account creation cancelled.");
  const user = await createUser(answers);
  console.log(`Created ${answers.role} account ${user.profile.email}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
