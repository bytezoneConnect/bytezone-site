const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { OAuth2Client } = require("google-auth-library");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bytezone-test-"));
process.env.BYTEZONE_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.BYTEZONE_DATABASE_PATH = path.join(temporaryDirectory, "test.sqlite");
process.env.BYTEZONE_VAULT_PATH = path.join(temporaryDirectory, "vault");
process.env.NODE_ENV = "test";

const { app, createUser } = require("../src/app");
const { db, migrate } = require("../src/database");
const { decryptJson } = require("../src/security");

test("authenticated rentals, encrypted ownership evidence, sales, and admin workflows", async (t) => {
  await migrate();
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  const originalGoogleConfig = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    publicOrigin: process.env.BYTEZONE_PUBLIC_ORIGIN,
  };
  process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
  process.env.BYTEZONE_PUBLIC_ORIGIN = "https://bytezone.example";
  t.after(() => {
    if (originalGoogleConfig.clientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = originalGoogleConfig.clientId;
    if (originalGoogleConfig.clientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = originalGoogleConfig.clientSecret;
    if (originalGoogleConfig.publicOrigin === undefined) delete process.env.BYTEZONE_PUBLIC_ORIGIN;
    else process.env.BYTEZONE_PUBLIC_ORIGIN = originalGoogleConfig.publicOrigin;
  });

  let googleIdentity;
  const originalGetToken = OAuth2Client.prototype.getToken;
  const originalVerifyIdToken = OAuth2Client.prototype.verifyIdToken;
  OAuth2Client.prototype.getToken = async (code) => {
    assert.equal(code, "mock-google-code");
    return { tokens: { id_token: "mock-google-id-token" } };
  };
  OAuth2Client.prototype.verifyIdToken = async ({ idToken, audience }) => {
    assert.equal(idToken, "mock-google-id-token");
    assert.equal(audience, "test-google-client-id");
    return { getPayload: () => googleIdentity };
  };
  t.after(() => {
    OAuth2Client.prototype.getToken = originalGetToken;
    OAuth2Client.prototype.verifyIdToken = originalVerifyIdToken;
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookies = new Map();
  let csrfToken = "";

  function updateCookies(response) {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (header.includes("Max-Age=0")) cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function call(url, { method = "GET", body, form, redirect = "follow" } = {}) {
    const headers = { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; ") };
    if (method !== "GET") headers["x-csrf-token"] = csrfToken;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${origin}${url}`, {
      method,
      headers,
      redirect,
      body: form || (body === undefined ? undefined : JSON.stringify(body)),
    });
    updateCookies(response);
    const responseBody = response.status === 204 ? null
      : response.headers.get("content-type")?.includes("application/json") ? await response.json()
        : await response.text();
    return { response, body: responseBody };
  }

  const csrfResponse = await call("/api/csrf");
  csrfToken = csrfResponse.body.csrfToken;
  assert.equal((await call("/api/auth/google/status")).body.clientId, "test-google-client-id");
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  assert.equal((await call("/api/auth/google/status")).body.clientId, "476466036015-8lomocr4u059678hk39n7p2jobdc5elt.apps.googleusercontent.com");
  const defaultClientResponse = await call("/api/auth/google/start", { redirect: "manual" });
  assert.equal(defaultClientResponse.response.status, 302);
  assert.equal(new URL(defaultClientResponse.response.headers.get("location")).searchParams.get("client_id"), "476466036015-8lomocr4u059678hk39n7p2jobdc5elt.apps.googleusercontent.com");
  process.env.GOOGLE_CLIENT_ID = googleClientId;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.equal((await call("/api/auth/google/status")).body.enabled, true);
  assert.equal((await call("/api/auth/google/start", { redirect: "manual" })).response.status, 503);
  process.env.GOOGLE_CLIENT_SECRET = googleClientSecret;
  assert.equal((await call("/api/health")).body.status, "ok");
  assert.equal((await call("/")).response.status, 200);
  assert.equal((await call("/ops")).response.status, 200);

  const customerPassword = "customer-password-12";
  const registration = await call("/api/auth/register", {
    method: "POST",
    body: { email: "customer@example.test", password: customerPassword, name: "Test Customer", phone: "0999000000" },
  });
  assert.equal(registration.response.status, 201);
  csrfToken = registration.body.csrfToken;
  const customerId = registration.body.user.id;

  delete process.env.GOOGLE_CLIENT_SECRET;
  const googleCredentialStatus = await call("/api/auth/google/status");
  assert.equal(googleCredentialStatus.body.enabled, true);
  assert.equal(googleCredentialStatus.body.clientId, "test-google-client-id");
  googleIdentity = {
    sub: "google-customer-subject",
    email: "customer@example.test",
    email_verified: true,
    name: "Test Customer",
    nonce: googleCredentialStatus.body.nonce,
  };
  const clientIdOnlyLogin = await call("/api/auth/google/credential", {
    method: "POST",
    body: { credential: "mock-google-id-token" },
  });
  assert.equal(clientIdOnlyLogin.response.status, 200);
  assert.equal(clientIdOnlyLogin.body.user.id, customerId);
  csrfToken = clientIdOnlyLogin.body.csrfToken;

  await call("/api/auth/google/status");
  const missingGoogleCredential = await call("/api/auth/google/credential", { method: "POST" });
  assert.equal(missingGoogleCredential.response.status, 400);

  await call("/api/auth/google/status");
  googleIdentity.nonce = "incorrect-nonce";
  const invalidNonceLogin = await call("/api/auth/google/credential", {
    method: "POST",
    body: { credential: "mock-google-id-token" },
  });
  assert.equal(invalidNonceLogin.response.status, 401);
  process.env.GOOGLE_CLIENT_SECRET = googleClientSecret;

  async function startGoogleSignIn(profile) {
    const response = await call("/api/auth/google/start", { redirect: "manual" });
    assert.equal(response.response.status, 302);
    const authorizationUrl = new URL(response.response.headers.get("location"));
    assert.equal(authorizationUrl.hostname, "accounts.google.com");
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://bytezone.example/api/auth/google/callback");
    googleIdentity = { ...profile, nonce: authorizationUrl.searchParams.get("nonce") };
    return authorizationUrl.searchParams.get("state");
  }

  async function completeGoogleSignIn(profile, overrideNonce) {
    const state = await startGoogleSignIn(profile);
    if (overrideNonce !== undefined) googleIdentity.nonce = overrideNonce;
    const response = await call(`/api/auth/google/callback?code=mock-google-code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    if (response.response.status === 302) csrfToken = cookies.get("bzcsrf");
    return response;
  }

  await startGoogleSignIn({});
  const rejectedState = await call("/api/auth/google/callback?code=mock-google-code&state=wrong", { redirect: "manual" });
  assert.equal(rejectedState.response.status, 400);

  const unverifiedGoogleLogin = await completeGoogleSignIn({
    sub: "google-unverified-subject",
    email: "customer@example.test",
    email_verified: false,
    name: "Test Customer",
  });
  assert.equal(unverifiedGoogleLogin.response.status, 401);

  const mismatchedNonceLogin = await completeGoogleSignIn({
    sub: "google-nonce-mismatch-subject",
    email: "customer@example.test",
    email_verified: true,
    name: "Test Customer",
  }, "incorrect-nonce");
  assert.equal(mismatchedNonceLogin.response.status, 401);

  const linkedGoogleLogin = await completeGoogleSignIn({
    sub: "google-customer-subject",
    email: "customer@example.test",
    email_verified: true,
    name: "Test Customer",
  });
  assert.equal(linkedGoogleLogin.response.status, 302);
  assert.equal(linkedGoogleLogin.response.headers.get("location"), "https://bytezone.example/ops");
  assert.equal((await call("/api/me")).body.user.id, customerId);
  assert.ok(db.prepare("SELECT google_sub_digest FROM users WHERE id = ?").get(customerId).google_sub_digest);

  const storedUser = db.prepare("SELECT encrypted_profile FROM users WHERE id = ?").get(customerId);
  assert.equal(storedUser.encrypted_profile.includes("customer@example.test"), false);
  assert.equal(decryptJson(storedUser.encrypted_profile).email, "customer@example.test");
  const inquiry = await call("/api/pos-inquiries", {
    method: "POST",
    body: { contact: "customer@example.test / 0999000000", message: "Please call about POS." },
  });
  assert.equal(inquiry.response.status, 201);

  const devices = await call("/api/devices");
  assert.equal(devices.response.status, 200);
  assert.deepEqual(devices.body.devices.map((device) => device.rate_mwk).sort((a, b) => a - b), [4000, 5999, 6700, 15000]);
  assert.equal((await call("/api/inventory")).response.status, 403);
  assert.deepEqual((await call("/api/biometrics/status")).body, { enrolled: false, scannerAvailable: false });
  assert.equal((await call("/api/biometrics/enroll", {
    method: "POST",
    body: { password: customerPassword },
  })).response.status, 503);

  const expectedReturnAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const rental = await call("/api/rentals", {
    method: "POST",
    body: { deviceId: "laptop-default", expectedReturnAt, depositMwk: 1000, password: customerPassword },
  });
  assert.equal(rental.response.status, 201);
  const customerRentals = await call("/api/rentals");
  assert.equal(customerRentals.body.rentals[0].status, "active");

  const proof = new FormData();
  proof.set("url", "https://example.test/private-page");
  proof.set("ownershipProof", "I am the person depicted and am requesting removal.");
  proof.set("proof", new Blob(["ownership proof"], { type: "text/plain" }), "proof.txt");
  const ticket = await call("/api/tickets", { method: "POST", form: proof });
  assert.equal(ticket.response.status, 201);
  const savedTicket = db.prepare("SELECT encrypted_details FROM takedown_tickets WHERE id = ?").get(ticket.body.ticket.id);
  assert.equal(savedTicket.encrypted_details.includes("example.test"), false);
  const ticketDetails = decryptJson(savedTicket.encrypted_details);
  const encryptedFile = fs.readFileSync(path.join(temporaryDirectory, "vault", `${ticketDetails.proofFileId}.vault`));
  assert.equal(encryptedFile.includes(Buffer.from("ownership proof")), false);

  const adminPassword = "admin-password-12";
  const admin = await createUser({ email: "admin@example.test", password: adminPassword, name: "Test Admin", role: "admin" });
  const adminLogin = await call("/api/auth/login", {
    method: "POST",
    body: { email: admin.profile.email, password: adminPassword },
  });
  assert.equal(adminLogin.response.status, 200);
  csrfToken = adminLogin.body.csrfToken;

  const inquiries = await call("/api/pos-inquiries");
  assert.equal(inquiries.body.inquiries[0].contact, "customer@example.test / 0999000000");
  const pricing = await call("/api/devices/laptop-default", { method: "PATCH", body: { rateMwk: 7000 } });
  assert.equal(pricing.response.status, 200);
  assert.equal(pricing.body.device.rate_mwk, 7000);
  await call("/api/devices/laptop-default", { method: "PATCH", body: { rateMwk: 6700 } });

  const adminTickets = await call("/api/tickets");
  assert.equal(adminTickets.body.tickets[0].url, "https://example.test/private-page");
  const updatedTicket = await call(`/api/tickets/${ticket.body.ticket.id}`, { method: "PATCH", body: { status: "In Review" } });
  assert.equal(updatedTicket.body.ticket.status, "In Review");

  const returned = await call(`/api/rentals/${rental.body.rental.id}/return`, {
    method: "POST",
    body: { password: adminPassword, useBiometric: true, depositDisposition: "applied" },
  });
  assert.equal(returned.response.status, 200);
  assert.equal(returned.body.totalMwk, 6700);
  assert.equal(returned.body.paidMwk, 1000);
  assert.equal(returned.body.balanceMwk, 5700);

  const secondRental = await call("/api/rentals", {
    method: "POST",
    body: {
      customerEmail: "customer@example.test",
      deviceId: "laptop-default",
      expectedReturnAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      depositMwk: 10000,
      password: adminPassword,
    },
  });
  assert.equal(secondRental.response.status, 201);
  const secondReturn = await call(`/api/rentals/${secondRental.body.rental.id}/return`, {
    method: "POST",
    body: { password: adminPassword, depositDisposition: "applied" },
  });
  assert.equal(secondReturn.body.depositRefundMwk, 3300);
  assert.equal(secondReturn.body.balanceMwk, 0);

  const product = await call("/api/inventory", {
    method: "POST",
    body: { name: "Test drink", barcode: "123456789", priceMwk: 1500, quantity: 3 },
  });
  assert.equal(product.response.status, 201);
  const sale = await call("/api/sales", {
    method: "POST",
    body: { items: [{ id: product.body.item.id, quantity: 2 }], paymentMethod: "cash", password: adminPassword },
  });
  assert.equal(sale.response.status, 201);
  assert.equal(sale.body.receipt.totalMwk, 3000);
  const report = await call("/api/sales/report");
  assert.equal(report.response.status, 200);
  assert.equal(report.body.totalMwk, 3000);
  const inventory = await call("/api/inventory");
  assert.equal(inventory.body.items[0].quantity, 1);

  const newGoogleLogin = await completeGoogleSignIn({
    sub: "google-new-customer-subject",
    email: "google-only@example.test",
    email_verified: true,
    name: "Google Customer",
  });
  assert.equal(newGoogleLogin.response.status, 302);
  const googleCustomer = (await call("/api/me")).body.user;
  assert.equal(googleCustomer.role, "customer");
  assert.equal(googleCustomer.profile.email, "google-only@example.test");
});
