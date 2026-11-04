const crypto = require("node:crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const path = require("node:path");
const { db } = require("./database");
const {
  decryptJson,
  digest,
  encryptJson,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} = require("./security");
const biometrics = require("./biometricsService");
const vault = require("./vault");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});
const sessionHours = Number(process.env.BYTEZONE_SESSION_HOURS || 12);
const ticketStatuses = new Set(["Submitted", "DMCA Sent", "In Review", "Removed", "Failed"]);

app.disable("x-powered-by");
app.set("trust proxy", process.env.NODE_ENV === "production" ? 1 : false);
app.use(require("helmet")({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.get("/operations.html", (req, res) => res.redirect(302, "/ops"));
app.use(express.static(path.resolve(__dirname, "..", "public"), { index: false, dotfiles: "deny", maxAge: "1h" }));
app.use("/images", express.static(path.resolve(__dirname, "..", "images"), { dotfiles: "deny", maxAge: "1d" }));
app.get("/", (req, res) => res.sendFile(path.resolve(__dirname, "..", "index.html")));
app.get("/sitemap.xml", (req, res) => res.sendFile(path.resolve(__dirname, "..", "sitemap.xml")));
app.get("/googlea569bbac5b256e52.html", (req, res) => res.sendFile(path.resolve(__dirname, "..", "googlea569bbac5b256e52.html")));
app.get("/ops", (req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.sendFile(path.resolve(__dirname, "..", "public", "operations.html"), (error) => {
    if (error) next(error);
  });
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requireText(value, label, maxLength = 200) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    fail(400, `${label} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

function requireMoney(value, label, allowZero = true) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail(400, `${label} must be a valid whole MWK amount.`);
  return value;
}

function newId() {
  return crypto.randomUUID();
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge,
  };
}

function ensureCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (origin) {
    let requestOrigin;
    try {
      requestOrigin = new URL(origin).origin;
    } catch {
      return res.status(403).json({ error: "Request origin verification failed." });
    }
    if (requestOrigin !== `${req.protocol}://${req.get("host")}`) {
      return res.status(403).json({ error: "Request origin verification failed." });
    }
  }
  const cookie = req.cookies.bzcsrf;
  const header = req.get("x-csrf-token");
  const cookieBytes = Buffer.from(cookie || "");
  const headerBytes = Buffer.from(header || "");
  if (!cookie || !header || cookieBytes.length !== headerBytes.length || !crypto.timingSafeEqual(cookieBytes, headerBytes)) {
    return res.status(403).json({ error: "Request verification failed. Refresh the page and try again." });
  }
  return next();
}

app.use("/api", (req, res, next) => {
  res.setHeader("cache-control", "no-store");
  return ensureCsrf(req, res, next);
});

function requireAuth(req, res, next) {
  const rawSession = req.cookies.bzsession;
  if (!rawSession) return res.status(401).json({ error: "Sign in to continue." });
  const session = db.prepare(`
    SELECT users.id, users.role, users.encrypted_profile, users.password_hash
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.id_digest = ? AND sessions.expires_at > ?
  `).get(digest(rawSession), new Date().toISOString());
  if (!session) return res.status(401).json({ error: "Your session has expired. Sign in again." });
  req.user = {
    id: session.id,
    role: session.role,
    passwordHash: session.password_hash,
    profile: decryptJson(session.encrypted_profile),
  };
  return next();
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "You do not have permission to perform this action." });
    return next();
  };
}

function isStaffRole(role) {
  return role === "admin" || role === "staff";
}

function setSession(res, userId) {
  const rawSession = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (id_digest, user_id, expires_at) VALUES (?, ?, ?)")
    .run(digest(rawSession), userId, expiresAt);
  res.cookie("bzsession", rawSession, cookieOptions(sessionHours * 60 * 60 * 1000));
  res.cookie("bzcsrf", csrf, { ...cookieOptions(sessionHours * 60 * 60 * 1000), httpOnly: false });
  return csrf;
}

async function createUser({ email, password, name, phone = "", role = "customer" }) {
  const normalizedEmail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) fail(400, "Enter a valid email address.");
  if (typeof password !== "string" || password.length < 12 || password.length > 200) fail(400, "Password must be 12 to 200 characters.");
  if (!["customer", "staff", "admin"].includes(role)) fail(400, "Invalid account role.");
  const profile = {
    email: normalizedEmail,
    name: requireText(name, "Name", 120),
    phone: String(phone || "").trim().slice(0, 40),
  };
  const id = newId();
  const passwordHash = await hashPassword(password);
  try {
    db.prepare(`
      INSERT INTO users (id, email_digest, encrypted_profile, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, digest(normalizedEmail), encryptJson(profile), passwordHash, role, new Date().toISOString());
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") fail(409, "An account with that email already exists.");
    throw error;
  }
  return { id, profile, role };
}

async function verifyStepUp(req) {
  if (req.body.useBiometric === true) {
    const result = await biometrics.verify(req.user.id);
    if (result.available && result.enrolled) {
      if (result.matched) return;
      fail(401, "Fingerprint did not match. Use your password only if the scanner is unavailable.");
    }
  }
  if (typeof req.body.password !== "string" || !await verifyPassword(req.body.password, req.user.passwordHash)) {
    fail(401, "Confirm this action with your password or an enrolled fingerprint.");
  }
}

function parseDate(value, label) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) fail(400, `${label} must be a valid date and time.`);
  return date;
}

function estimateRental(rental, at = Date.now()) {
  const elapsed = Math.max(0, at - new Date(rental.checked_out_at).getTime());
  const intervalMs = rental.billing_unit === "day" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const units = Math.max(1, Math.ceil(elapsed / intervalMs));
  return units * rental.rate_mwk;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes." },
});
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many account creation attempts. Try again later." },
});

app.get("/api/csrf", (req, res) => {
  const token = crypto.randomBytes(32).toString("base64url");
  res.cookie("bzcsrf", token, { ...cookieOptions(24 * 60 * 60 * 1000), httpOnly: false });
  res.json({ csrfToken: token });
});

app.post("/api/auth/register", registrationLimiter, asyncRoute(async (req, res) => {
  const user = await createUser({ ...req.body, role: "customer" });
  const csrfToken = setSession(res, user.id);
  res.status(201).json({ user: { id: user.id, role: user.role, profile: user.profile }, csrfToken });
}));

app.post("/api/auth/login", loginLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const row = db.prepare("SELECT * FROM users WHERE email_digest = ?").get(digest(email));
  if (!row) fail(401, "Email or password is incorrect.");
  let authenticated = false;
  if (req.body.useBiometric === true && !row.biometric_template && !req.body.password) {
    fail(401, "Fingerprint is not enrolled. Use your password.");
  }
  if (req.body.useBiometric === true && row.biometric_template) {
    const result = await biometrics.verify(row.id);
    if (result.available && result.enrolled) {
      if (!result.matched) fail(401, "Fingerprint did not match.");
      authenticated = true;
    }
  }
  if (!authenticated) {
    if (typeof req.body.password !== "string" || !await verifyPassword(req.body.password, row.password_hash)) {
      fail(401, "Email or password is incorrect.");
    }
  }
  const csrfToken = setSession(res, row.id);
  res.json({ user: { id: row.id, role: row.role, profile: decryptJson(row.encrypted_profile) }, csrfToken });
}));

app.post("/api/auth/logout", requireAuth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE id_digest = ?").run(digest(req.cookies.bzsession));
  res.clearCookie("bzsession", cookieOptions(0));
  res.clearCookie("bzcsrf", { ...cookieOptions(0), httpOnly: false });
  res.status(204).end();
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, role: req.user.role, profile: req.user.profile } });
});

app.get("/api/biometrics/status", requireAuth, asyncRoute(async (req, res) => {
  res.json({ enrolled: biometrics.isEnrolled(req.user.id), scannerAvailable: await biometrics.scannerStatus() });
}));

app.post("/api/biometrics/enroll", requireAuth, asyncRoute(async (req, res) => {
  if (typeof req.body.password !== "string" || !await verifyPassword(req.body.password, req.user.passwordHash)) {
    fail(401, "Confirm enrollment with your password.");
  }
  const result = await biometrics.enroll(req.user.id);
  if (!result.available) fail(503, "Fingerprint scanner is unavailable. Password sign-in remains available.");
  res.json({ enrolled: true });
}));

app.get("/api/devices", requireAuth, (req, res) => {
  const devices = db.prepare(`
    SELECT id, name, type, billing_unit, rate_mwk, status FROM devices
    ${req.user.role === "customer" ? "WHERE status = 'available'" : ""}
    ORDER BY name
  `).all();
  res.json({ devices });
});

app.post("/api/devices", requireAuth, requireRoles("admin"), (req, res) => {
  const type = requireText(req.body.type, "Device type", 50);
  const billingUnit = req.body.billingUnit;
  if (!["hour", "day"].includes(billingUnit)) fail(400, "Billing unit must be hour or day.");
  const device = {
    id: newId(),
    name: requireText(req.body.name, "Device name", 100),
    type,
    billingUnit,
    rate: requireMoney(req.body.rateMwk, "Rate"),
  };
  db.prepare(`
    INSERT INTO devices (id, name, type, billing_unit, rate_mwk, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(device.id, device.name, device.type, device.billingUnit, device.rate, new Date().toISOString());
  res.status(201).json({ device: { ...device, rate_mwk: device.rate, billing_unit: device.billingUnit, status: "available" } });
});

app.patch("/api/devices/:id", requireAuth, requireRoles("admin"), (req, res) => {
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(req.params.id);
  if (!device) fail(404, "Device not found.");
  const status = req.body.status || device.status;
  const rate = req.body.rateMwk === undefined ? device.rate_mwk : requireMoney(req.body.rateMwk, "Rate");
  const name = req.body.name === undefined ? device.name : requireText(req.body.name, "Device name", 100);
  if (!["available", "rented", "maintenance"].includes(status)) fail(400, "Invalid device status.");
  const activeRental = db.prepare("SELECT 1 FROM rentals WHERE device_id = ? AND status = 'active'").get(device.id);
  if (status === "rented" && !activeRental) fail(409, "Rented status is set automatically when a rental starts.");
  if (status !== "rented" && activeRental) {
    fail(409, "An active rental must be returned before making this device available.");
  }
  db.prepare("UPDATE devices SET name = ?, rate_mwk = ?, status = ? WHERE id = ?").run(name, rate, status, device.id);
  res.json({ device: db.prepare("SELECT id, name, type, billing_unit, rate_mwk, status FROM devices WHERE id = ?").get(device.id) });
});

app.get("/api/rentals", requireAuth, (req, res) => {
  const filter = isStaffRole(req.user.role) ? "" : "WHERE rentals.customer_id = ?";
  const rows = db.prepare(`
    SELECT rentals.*, devices.name AS device_name,
      (SELECT COALESCE(SUM(amount_mwk), 0) FROM rental_payments WHERE rental_id = rentals.id) AS paid_mwk
    FROM rentals JOIN devices ON devices.id = rentals.device_id
    ${filter}
    ORDER BY rentals.checked_out_at DESC LIMIT 200
  `).all(...(filter ? [req.user.id] : []));
  res.json({
    rentals: rows.map((row) => {
      const customer = isStaffRole(req.user.role) ? decryptJson(row.encrypted_customer) : req.user.profile;
      return {
        id: row.id,
        customer: { name: customer.name, ...(isStaffRole(req.user.role) ? { phone: customer.phone } : {}) },
        deviceId: row.device_id,
        deviceName: row.device_name,
        status: row.status,
        checkedOutAt: row.checked_out_at,
        expectedReturnAt: row.expected_return_at,
        returnedAt: row.returned_at,
        rateMwk: row.rate_mwk,
        billingUnit: row.billing_unit,
        depositMwk: row.deposit_mwk,
        depositStatus: row.deposit_status,
        totalMwk: row.total_mwk,
        currentEstimateMwk: row.status === "active" ? estimateRental(row) : row.total_mwk,
        paidMwk: row.paid_mwk,
        overdue: row.status === "active" && Date.now() > new Date(row.expected_return_at).getTime(),
      };
    }),
  });
});

app.post("/api/rentals", requireAuth, asyncRoute(async (req, res) => {
  if (!["customer", "admin", "staff"].includes(req.user.role)) fail(403, "You cannot create rentals.");
  const device = db.prepare("SELECT * FROM devices WHERE id = ?").get(requireText(req.body.deviceId, "Device", 80));
  if (!device || device.status !== "available") fail(409, "That device is not available.");
  const expectedReturnAt = parseDate(req.body.expectedReturnAt, "Expected return time");
  if (expectedReturnAt.getTime() <= Date.now() || expectedReturnAt.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) {
    fail(400, "Return time must be in the next 30 days.");
  }
  let customer;
  if (req.user.role === "customer") {
    customer = db.prepare("SELECT id, encrypted_profile FROM users WHERE id = ? AND role = 'customer'").get(req.user.id);
  } else if (req.body.customerEmail) {
    customer = db.prepare("SELECT id, encrypted_profile FROM users WHERE email_digest = ? AND role = 'customer'")
      .get(digest(normalizeEmail(req.body.customerEmail)));
  } else {
    const customerId = requireText(req.body.customerId, "Customer account", 80);
    customer = db.prepare("SELECT id, encrypted_profile FROM users WHERE id = ? AND role = 'customer'").get(customerId);
  }
  if (!customer) fail(404, "Customer account not found.");
  const deposit = requireMoney(req.body.depositMwk ?? 0, "Deposit");
  if (deposit > 0) await verifyStepUp(req);
  const id = newId();
  const now = new Date().toISOString();
  const create = db.transaction(() => {
    const currentDevice = db.prepare("SELECT status FROM devices WHERE id = ?").get(device.id);
    if (!currentDevice || currentDevice.status !== "available") fail(409, "That device was just rented by another customer.");
    db.prepare(`
      INSERT INTO rentals (id, customer_id, device_id, encrypted_customer, status, checked_out_at,
        expected_return_at, rate_mwk, billing_unit, deposit_mwk, deposit_status, created_by)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, customer.id, device.id, customer.encrypted_profile, now, expectedReturnAt.toISOString(),
      device.rate_mwk, device.billing_unit, deposit, deposit > 0 ? "held" : "none", req.user.id,
    );
    db.prepare("UPDATE devices SET status = 'rented' WHERE id = ?").run(device.id);
  });
  create();
  res.status(201).json({ rental: { id, device: device.name, status: "active", checkedOutAt: now, expectedReturnAt: expectedReturnAt.toISOString(), rateMwk: device.rate_mwk, billingUnit: device.billing_unit, depositMwk: deposit } });
}));

app.post("/api/rentals/:id/return", requireAuth, requireRoles("admin", "staff"), asyncRoute(async (req, res) => {
  await verifyStepUp(req);
  const rental = db.prepare("SELECT * FROM rentals WHERE id = ?").get(req.params.id);
  if (!rental || rental.status !== "active") fail(404, "Active rental not found.");
  const disposition = rental.deposit_mwk === 0 ? "none" : req.body.depositDisposition;
  if (rental.deposit_mwk > 0 && !["refunded", "applied"].includes(disposition)) {
    fail(400, "Choose whether to refund or apply the held deposit.");
  }
  const total = estimateRental(rental);
  const paid = db.prepare("SELECT COALESCE(SUM(amount_mwk), 0) AS total FROM rental_payments WHERE rental_id = ?").get(rental.id).total;
  const depositApplied = disposition === "applied" ? Math.min(rental.deposit_mwk, Math.max(0, total - paid)) : 0;
  const depositRefundMwk = rental.deposit_mwk - depositApplied;
  db.transaction(() => {
    const changed = db.prepare(`
      UPDATE rentals SET status = 'returned', returned_at = ?, total_mwk = ?, deposit_status = ?
      WHERE id = ? AND status = 'active'
    `).run(new Date().toISOString(), total, disposition, rental.id);
    if (changed.changes !== 1) fail(409, "Rental was already returned.");
    db.prepare("UPDATE devices SET status = 'available' WHERE id = ? AND status = 'rented'").run(rental.device_id);
    if (depositApplied > 0) {
      db.prepare(`
        INSERT INTO rental_payments (id, rental_id, amount_mwk, payment_method, confirmed_by, created_at)
        VALUES (?, ?, ?, 'deposit', ?, ?)
      `).run(newId(), rental.id, depositApplied, req.user.id, new Date().toISOString());
    }
  })();
  const finalPaid = db.prepare("SELECT COALESCE(SUM(amount_mwk), 0) AS total FROM rental_payments WHERE rental_id = ?").get(rental.id).total;
  res.json({ rentalId: rental.id, totalMwk: total, paidMwk: finalPaid, balanceMwk: Math.max(0, total - finalPaid), depositStatus: disposition, depositRefundMwk });
}));

app.post("/api/rentals/:id/payment", requireAuth, requireRoles("admin", "staff"), asyncRoute(async (req, res) => {
  await verifyStepUp(req);
  const rental = db.prepare("SELECT * FROM rentals WHERE id = ?").get(req.params.id);
  if (!rental || rental.status !== "returned") fail(404, "Returned rental not found.");
  const amount = requireMoney(req.body.amountMwk, "Payment", false);
  const method = requireText(req.body.paymentMethod, "Payment method", 30);
  if (!["cash", "mobile money", "card"].includes(method)) fail(400, "Unsupported payment method.");
  const estimate = rental.total_mwk;
  const paid = db.prepare("SELECT COALESCE(SUM(amount_mwk), 0) AS total FROM rental_payments WHERE rental_id = ?").get(rental.id).total;
  if (amount > estimate - paid) fail(400, "Payment exceeds the outstanding balance.");
  db.prepare(`
    INSERT INTO rental_payments (id, rental_id, amount_mwk, payment_method, confirmed_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(newId(), rental.id, amount, method, req.user.id, new Date().toISOString());
  res.status(201).json({ rentalId: rental.id, paidMwk: paid + amount, balanceMwk: estimate - paid - amount });
}));

app.get("/api/inventory", requireAuth, requireRoles("admin", "staff"), (req, res) => {
  res.json({ items: db.prepare("SELECT id, name, barcode, price_mwk, quantity FROM inventory ORDER BY name").all() });
});

app.post("/api/inventory", requireAuth, requireRoles("admin"), (req, res) => {
  const item = {
    id: newId(),
    name: requireText(req.body.name, "Item name", 120),
    barcode: req.body.barcode ? requireText(req.body.barcode, "Barcode", 80) : null,
    price: requireMoney(req.body.priceMwk, "Price"),
    quantity: requireMoney(req.body.quantity, "Stock quantity"),
  };
  try {
    db.prepare("INSERT INTO inventory (id, name, barcode, price_mwk, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(item.id, item.name, item.barcode, item.price, item.quantity, new Date().toISOString());
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") fail(409, "That barcode is already assigned.");
    throw error;
  }
  res.status(201).json({ item: { id: item.id, name: item.name, barcode: item.barcode, priceMwk: item.price, quantity: item.quantity } });
});

app.patch("/api/inventory/:id", requireAuth, requireRoles("admin"), (req, res) => {
  const item = db.prepare("SELECT * FROM inventory WHERE id = ?").get(req.params.id);
  if (!item) fail(404, "Inventory item not found.");
  const name = req.body.name === undefined ? item.name : requireText(req.body.name, "Item name", 120);
  const barcode = req.body.barcode === undefined ? item.barcode : (req.body.barcode ? requireText(req.body.barcode, "Barcode", 80) : null);
  const price = req.body.priceMwk === undefined ? item.price_mwk : requireMoney(req.body.priceMwk, "Price");
  const quantity = req.body.quantity === undefined ? item.quantity : requireMoney(req.body.quantity, "Stock quantity");
  try {
    db.prepare("UPDATE inventory SET name = ?, barcode = ?, price_mwk = ?, quantity = ? WHERE id = ?")
      .run(name, barcode, price, quantity, item.id);
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") fail(409, "That barcode is already assigned.");
    throw error;
  }
  res.json({ item: db.prepare("SELECT id, name, barcode, price_mwk, quantity FROM inventory WHERE id = ?").get(item.id) });
});

app.post("/api/sales", requireAuth, requireRoles("admin", "staff"), asyncRoute(async (req, res) => {
  await verifyStepUp(req);
  if (!Array.isArray(req.body.items) || req.body.items.length < 1 || req.body.items.length > 100) fail(400, "Add at least one item to the sale.");
  const method = requireText(req.body.paymentMethod, "Payment method", 30);
  if (!["cash", "mobile money", "card"].includes(method)) fail(400, "Unsupported payment method.");
  const saleItems = req.body.items.map((line) => {
    const id = requireText(line.id, "Item", 80);
    const quantity = requireMoney(line.quantity, "Quantity", false);
    const item = db.prepare("SELECT id, name, barcode, price_mwk, quantity FROM inventory WHERE id = ?").get(id);
    if (!item) fail(404, "An item in this sale was not found.");
    if (item.quantity < quantity) fail(409, `Not enough stock for ${item.name}.`);
    return { id: item.id, name: item.name, barcode: item.barcode, quantity, unitPriceMwk: item.price_mwk, lineTotalMwk: item.price_mwk * quantity };
  });
  const total = saleItems.reduce((sum, item) => sum + item.lineTotalMwk, 0);
  if (!Number.isSafeInteger(total)) fail(400, "Sale total is outside the supported range.");
  const saleId = newId();
  const createdAt = new Date().toISOString();
  db.transaction(() => {
    for (const item of saleItems) {
      const result = db.prepare("UPDATE inventory SET quantity = quantity - ? WHERE id = ? AND quantity >= ?")
        .run(item.quantity, item.id, item.quantity);
      if (result.changes !== 1) fail(409, `Stock changed during checkout for ${item.name}.`);
    }
    db.prepare("INSERT INTO sales (id, staff_id, items_json, total_mwk, payment_method, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(saleId, req.user.id, JSON.stringify(saleItems), total, method, createdAt);
  })();
  res.status(201).json({ receipt: { id: saleId, items: saleItems, totalMwk: total, paymentMethod: method, createdAt } });
}));

app.get("/api/sales/report", requireAuth, requireRoles("admin"), (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, "Date must use YYYY-MM-DD.");
  const start = `${date}T00:00:00.000Z`;
  const end = `${date}T23:59:59.999Z`;
  const summary = db.prepare(`
    SELECT COUNT(*) AS sale_count, COALESCE(SUM(total_mwk), 0) AS total_mwk
    FROM sales WHERE created_at BETWEEN ? AND ?
  `).get(start, end);
  const sales = db.prepare("SELECT id, items_json, total_mwk, payment_method, created_at FROM sales WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC")
    .all(start, end).map((sale) => ({ id: sale.id, items: JSON.parse(sale.items_json), totalMwk: sale.total_mwk, paymentMethod: sale.payment_method, createdAt: sale.created_at }));
  res.json({ date, saleCount: summary.sale_count, totalMwk: summary.total_mwk, sales });
});

app.post("/api/tickets", requireAuth, upload.single("proof"), asyncRoute(async (req, res) => {
  if (!req.file) fail(400, "Upload proof of ownership to submit a ticket.");
  let url;
  try {
    url = new URL(requireText(req.body.url, "Content URL", 2048));
  } catch {
    fail(400, "Enter a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") fail(400, "The content URL must use HTTPS.");
  const ownershipProof = requireText(req.body.ownershipProof, "Ownership explanation", 5000);
  const id = newId();
  const stored = await vault.storeFile(req.file.buffer);
  try {
    db.transaction(() => {
      db.prepare("INSERT INTO vault_files (id, owner_id, created_at) VALUES (?, ?, ?)")
        .run(stored.id, req.user.id, new Date().toISOString());
      db.prepare(`
        INSERT INTO takedown_tickets (id, customer_id, encrypted_details, status, created_at, updated_at)
        VALUES (?, ?, ?, 'Submitted', ?, ?)
      `).run(
        id, req.user.id,
        encryptJson({ url: url.toString(), ownershipProof, proofFileId: stored.id, proofName: req.file.originalname.slice(0, 255) }),
        new Date().toISOString(), new Date().toISOString(),
      );
    })();
  } catch (error) {
    await vault.removeFile(stored.id);
    throw error;
  }
  res.status(201).json({ ticket: { id, status: "Submitted" } });
}));

app.get("/api/tickets", requireAuth, requireRoles("admin"), (req, res) => {
  const rows = db.prepare("SELECT * FROM takedown_tickets ORDER BY created_at DESC LIMIT 200").all();
  res.json({ tickets: rows.map((row) => ({ id: row.id, customerId: row.customer_id, ...decryptJson(row.encrypted_details), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at })) });
});

app.get("/api/tickets/mine", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT id, status, created_at, updated_at FROM takedown_tickets WHERE customer_id = ? ORDER BY created_at DESC")
    .all(req.user.id);
  res.json({ tickets: rows.map((row) => ({ id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at })) });
});

app.patch("/api/tickets/:id", requireAuth, requireRoles("admin"), (req, res) => {
  const status = requireText(req.body.status, "Ticket status", 30);
  if (!ticketStatuses.has(status)) fail(400, "Invalid ticket status.");
  const result = db.prepare("UPDATE takedown_tickets SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, new Date().toISOString(), req.params.id);
  if (!result.changes) fail(404, "Ticket not found.");
  res.json({ ticket: { id: req.params.id, status } });
});

app.get("/api/vault/:id", requireAuth, asyncRoute(async (req, res) => {
  const file = db.prepare("SELECT owner_id FROM vault_files WHERE id = ?").get(req.params.id);
  if (!file) fail(404, "File not found.");
  if (file.owner_id !== req.user.id && req.user.role !== "admin") fail(403, "You cannot access this file.");
  res.set({ "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="ownership-proof.bin"', "cache-control": "no-store" });
  res.send(await vault.readFile(req.params.id));
}));

app.post("/api/pos-inquiries", requireAuth, asyncRoute(async (req, res) => {
  const contact = requireText(req.body.contact, "Preferred contact details", 250);
  const message = String(req.body.message || "").trim().slice(0, 2000);
  const id = newId();
  db.prepare("INSERT INTO pos_inquiries (id, customer_id, encrypted_details, created_at) VALUES (?, ?, ?, ?)")
    .run(id, req.user.id, encryptJson({ contact, message, packagePriceMwk: 4900899 }), new Date().toISOString());
  res.status(201).json({ inquiryId: id, packagePriceMwk: 4900899 });
}));

app.get("/api/pos-inquiries", requireAuth, requireRoles("admin"), (req, res) => {
  const inquiries = db.prepare("SELECT id, customer_id, encrypted_details, created_at FROM pos_inquiries ORDER BY created_at DESC LIMIT 200")
    .all().map((row) => ({ id: row.id, customerId: row.customer_id, ...decryptJson(row.encrypted_details), createdAt: row.created_at }));
  res.json({ inquiries });
});

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) ? error.status
    : error instanceof multer.MulterError ? (error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
      : 500;
  if (status >= 500 && process.env.NODE_ENV !== "test") console.error(error);
  const message = status === 500 ? "The request could not be completed. Contact the system administrator." : error.message;
  return res.status(status).json({ error: message });
});

module.exports = { app, createUser };
