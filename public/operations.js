const state = { user: null, devices: [], inventory: [], cart: new Map(), register: false, scannerAvailable: false, biometricEnrolled: false };
let csrfToken = "";

const byId = (id) => document.getElementById(id);
const money = (amount) => `MWK ${Number(amount || 0).toLocaleString("en-MW")}`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const isStaff = () => ["admin", "staff"].includes(state.user?.role);
const isAdmin = () => state.user?.role === "admin";

function notify(message, error = false) {
  const notice = byId("notice");
  notice.textContent = message;
  notice.classList.remove("hidden", "border-bytezone-mint/30", "text-rose-300");
  notice.classList.add(error ? "text-rose-300" : "border-bytezone-mint/30");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadAdminDashboard() {
  if (!isAdmin()) return;
  const stats = await request("/api/admin/dashboard");
  byId("stat-customers").textContent = stats.customers.toLocaleString();
  byId("stat-active-rentals").textContent = stats.activeRentals.toLocaleString();
  byId("stat-sales-count").textContent = stats.saleCount.toLocaleString();
  byId("stat-sales-total").textContent = money(stats.salesTotalMwk);
  byId("stat-open-tickets").textContent = stats.openTickets.toLocaleString();
}

async function loadCustomers() {
  if (!isAdmin()) return;
  const { customers } = await request("/api/customers");
  byId("customer-list").innerHTML = customers.map((customer) => `
    <form class="grid gap-2 rounded-lg border border-white/10 p-3 sm:grid-cols-[1fr_1fr_1fr_auto]" data-edit-customer="${escapeHtml(customer.id)}">
      <div class="self-center text-sm"><strong>${escapeHtml(customer.email)}</strong><small class="block text-slate-400">Joined ${new Date(customer.createdAt).toLocaleDateString()}</small></div>
      <input name="name" class="form-input" value="${escapeHtml(customer.name)}" aria-label="Name for ${escapeHtml(customer.email)}" required maxlength="120">
      <input name="phone" class="form-input" value="${escapeHtml(customer.phone || "")}" aria-label="Phone for ${escapeHtml(customer.email)}" maxlength="40">
      <button class="secondary-button justify-center" type="submit">Save</button>
    </form>`).join("") || '<p class="text-sm text-slate-400">No customers yet.</p>';
}

async function loadSales() {
  if (!isAdmin()) return;
  const { sales } = await request("/api/sales");
  byId("sales-history-list").innerHTML = sales.map((sale) => `
    <article class="rounded-xl border border-white/10 p-4">
      <div class="flex items-center justify-between gap-2"><strong>${money(sale.totalMwk)}</strong><small>${new Date(sale.createdAt).toLocaleString()}</small></div>
      <p class="mt-1 text-xs text-slate-400">${escapeHtml(sale.staffName)} · ${escapeHtml(sale.paymentMethod)}</p>
      <ul class="mt-2 text-sm text-slate-300">${sale.items.map((item) => `<li>${escapeHtml(item.name)} × ${item.quantity} · ${money(item.lineTotalMwk)}</li>`).join("")}</ul>
    </article>`).join("") || '<p class="text-sm text-slate-400">No sales recorded.</p>';
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("content-type", "application/json");
  if (!["GET", "HEAD"].includes((options.method || "GET").toUpperCase())) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}

function jsonBody(value) {
  return JSON.stringify(value);
}

function loadGoogleIdentityServices() {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => window.google?.accounts?.id
      ? resolve()
      : reject(new Error("Google sign-in could not be loaded."));
    script.onerror = () => reject(new Error("Google sign-in could not be loaded."));
    document.head.append(script);
  });
}

function finishLogin(result) {
  state.user = result.user;
  csrfToken = result.csrfToken;
  showWorkspace();
  const defaultReturn = new Date(Date.now() + 60 * 60 * 1000);
  defaultReturn.setMinutes(defaultReturn.getMinutes() - defaultReturn.getTimezoneOffset());
  byId("expected-return").value = defaultReturn.toISOString().slice(0, 16);
  notify(`Welcome, ${state.user.profile.name}.`);
}

function showWorkspace() {
  byId("auth-panel").classList.toggle("hidden", Boolean(state.user));
  byId("workspace").classList.toggle("hidden", !state.user);
  byId("logout-button").classList.toggle("hidden", !state.user);
  byId("user-label").textContent = state.user ? `${state.user.profile.name} · ${state.user.id.slice(0, 8)}` : "";
  byId("role-badge").textContent = state.user?.role || "";
  byId("staff-tools").classList.toggle("hidden", !isStaff());
  byId("device-admin").classList.toggle("hidden", !isAdmin());
  byId("pos-panel").classList.toggle("hidden", !isStaff());
  byId("inventory-panel").classList.toggle("hidden", !isAdmin());
  byId("report-panel").classList.toggle("hidden", !isAdmin());
  byId("ticket-admin-panel").classList.toggle("hidden", !isAdmin());
  byId("pos-inquiries-panel").classList.toggle("hidden", !isAdmin());
  byId("admin-dashboard-panel").classList.toggle("hidden", !isAdmin());
  byId("customer-management-panel").classList.toggle("hidden", !isAdmin());
  byId("sales-history-panel").classList.toggle("hidden", !isAdmin());
  byId("customer-id-field").classList.toggle("hidden", !isStaff());
  byId("deposit-field").classList.toggle("hidden", !isStaff());
  byId("rental-form").classList.toggle("hidden", !isStaff() && state.user?.role !== "customer");
  byId("biometric-form").classList.toggle("hidden", false);
  if (state.user) void refreshAll();
}

async function loadDevices() {
  const result = await request("/api/devices");
  state.devices = result.devices;
  byId("device-list").innerHTML = state.devices.map((device) => `
    <div class="rounded-xl border border-white/10 bg-bytezone-ink/70 p-3">
      <div class="flex items-center justify-between gap-2">
        <strong>${escapeHtml(device.name)}</strong>
        <span class="text-sm text-bytezone-mint">${money(device.rate_mwk)}/${device.billing_unit === "day" ? "day" : "hr"}</span>
      </div>
      <p class="mt-1 text-xs capitalize text-slate-400">${escapeHtml(device.type)} · ${escapeHtml(device.status)}</p>
    </div>`).join("") || '<p class="text-sm text-slate-400">No devices available.</p>';
  byId("rental-device").innerHTML = state.devices
    .filter((device) => device.status === "available")
    .map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)} — ${money(device.rate_mwk)}/${device.billing_unit === "day" ? "day" : "hr"}</option>`).join("");
  if (isAdmin()) {
    const allDevices = await request("/api/devices");
    byId("device-admin-list").innerHTML = allDevices.devices.map((device) => `
      <form class="grid gap-2 rounded-lg border border-white/10 p-3 sm:grid-cols-[1fr_120px_150px_auto]" data-edit-device="${escapeHtml(device.id)}">
        <span class="self-center text-sm">${escapeHtml(device.name)} · ${device.billing_unit}</span>
        <input name="rateMwk" type="number" min="0" value="${device.rate_mwk}" class="form-input" aria-label="Rate for ${escapeHtml(device.name)}">
        <select name="status" class="form-input">
          ${["available", "rented", "maintenance"].map((status) => `<option ${status === "rented" && status !== device.status ? "disabled" : ""} ${status === device.status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
        <button class="secondary-button justify-center" type="submit">Save</button>
      </form>`).join("");
  }
}

async function loadRentals() {
  const result = await request("/api/rentals");
  byId("rental-list").innerHTML = result.rentals.map((rental) => `
    <div class="rounded-xl border ${rental.overdue ? "border-amber-400/60" : "border-white/10"} bg-bytezone-ink/70 p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <strong>${escapeHtml(rental.deviceName)}${isStaff() ? ` · ${escapeHtml(rental.customer.name)}${rental.customer.email ? ` (${escapeHtml(rental.customer.email)})` : ""}` : ""}</strong>
        ${rental.overdue ? '<span class="text-xs font-bold text-amber-300">OVERDUE</span>' : ""}
      </div>
      <p class="mt-2 text-xs text-slate-400">Expected ${new Date(rental.expectedReturnAt).toLocaleString()} · Deposit ${money(rental.depositMwk)} (${escapeHtml(rental.depositStatus)})</p>
      <p class="mt-2 text-sm">Bill now: <strong>${money(rental.currentEstimateMwk)}</strong> · Paid: ${money(rental.paidMwk)}</p>
      ${isStaff() ? (rental.status === "active" ? `<button class="secondary-button mt-3" data-return-rental="${escapeHtml(rental.id)}">Check in &amp; confirm payment</button>` : `<button class="secondary-button mt-3" data-pay-rental="${escapeHtml(rental.id)}" ${rental.paidMwk >= rental.totalMwk ? "disabled" : ""}>Record payment · balance ${money(Math.max(0, rental.totalMwk - rental.paidMwk))}</button>`) : ""}
    </div>`).join("") || '<p class="text-sm text-slate-400">No rental history yet.</p>';
}

async function loadInventory() {
  if (!isStaff()) return;
  const result = await request("/api/inventory");
  state.inventory = result.items;
  if (isAdmin()) {
    byId("inventory-list").innerHTML = result.items.map((item) => `
      <form class="grid gap-2 rounded-lg border border-white/10 p-3 sm:grid-cols-[1fr_110px_100px_auto]" data-edit-item="${escapeHtml(item.id)}">
        <span class="self-center text-sm">${escapeHtml(item.name)} ${item.barcode ? `<small class="text-slate-400">· ${escapeHtml(item.barcode)}</small>` : ""}</span>
        <input name="priceMwk" type="number" min="0" value="${item.price_mwk}" class="form-input" aria-label="Price for ${escapeHtml(item.name)}">
        <input name="quantity" type="number" min="0" value="${item.quantity}" class="form-input" aria-label="Stock for ${escapeHtml(item.name)}">
        <button class="secondary-button justify-center" type="submit">Save</button>
      </form>`).join("") || '<p class="text-sm text-slate-400">No inventory items yet.</p>';
  }
  byId("pos-items").innerHTML = result.items.filter((item) => item.quantity > 0).map((item) => `
    <button class="flex items-center justify-between gap-3 rounded-lg border border-white/10 p-3 text-left hover:border-bytezone-mint" data-add-item="${escapeHtml(item.id)}" type="button">
      <span>${escapeHtml(item.name)} <small class="text-slate-400">(${item.quantity} available)</small></span><strong>${money(item.price_mwk)}</strong>
    </button>`).join("") || '<p class="text-sm text-slate-400">No products in stock.</p>';
}

function drawCart() {
  const lines = [...state.cart.values()];
  const total = lines.reduce((sum, line) => sum + line.price_mwk * line.quantity, 0);
  byId("cart").innerHTML = lines.map((line) => `
    <div class="flex items-center justify-between gap-2 text-sm">
      <span>${escapeHtml(line.name)} × ${line.quantity}</span><span>${money(line.price_mwk * line.quantity)}</span>
      <button class="text-rose-300" data-remove-item="${escapeHtml(line.id)}" aria-label="Remove ${escapeHtml(line.name)}" type="button">Remove</button>
    </div>`).join("") + `<strong class="mt-2 text-right text-bytezone-mint">Total ${money(total)}</strong>`;
}

async function loadTickets() {
  if (isAdmin()) {
    const { tickets } = await request("/api/tickets");
    byId("ticket-admin-list").innerHTML = tickets.map((ticket) => `
      <article class="rounded-xl border border-white/10 p-4">
        <div class="flex items-center justify-between gap-2"><strong>${escapeHtml(ticket.status)}</strong><small>${new Date(ticket.createdAt).toLocaleDateString()}</small></div>
        <p class="mt-2 text-sm">${escapeHtml(ticket.customer.name)} · ${escapeHtml(ticket.customer.email)}</p>
        <a class="mt-2 block break-all text-sm text-bytezone-blue underline" href="${escapeHtml(ticket.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ticket.url)}</a>
        <p class="mt-2 text-sm text-slate-300">${escapeHtml(ticket.ownershipProof)}</p>
        <a class="mt-2 inline-block text-sm text-bytezone-mint underline" href="/api/vault/${encodeURIComponent(ticket.proofFileId)}">Download encrypted evidence</a>
        ${ticket.status === "Submitted" ? `<div class="mt-3 flex gap-2"><button class="secondary-button" data-ticket-decision="Approved" data-ticket-id="${escapeHtml(ticket.id)}" type="button">Approve</button><button class="secondary-button" data-ticket-decision="Rejected" data-ticket-id="${escapeHtml(ticket.id)}" type="button">Reject</button></div>` : ""}
        <select class="form-input mt-3" data-ticket-status="${escapeHtml(ticket.id)}">
          ${["Submitted", "Approved", "Rejected", "DMCA Sent", "In Review", "Removed", "Failed"].map((status) => `<option ${status === ticket.status ? "selected" : ""}>${status}</option>`).join("")}
        </select>
      </article>`).join("") || '<p class="text-sm text-slate-400">No requests submitted.</p>';
  } else {
    const { tickets } = await request("/api/tickets/mine");
    byId("my-tickets").innerHTML = tickets.map((ticket) => `
      <p class="rounded-lg border border-white/10 p-3 text-sm">Ticket ${escapeHtml(ticket.id.slice(0, 8))} · <strong>${escapeHtml(ticket.status)}</strong></p>`).join("");
  }
}

async function loadInquiries() {
  if (!isAdmin()) return;
  const { inquiries } = await request("/api/pos-inquiries");
  byId("pos-inquiry-list").innerHTML = inquiries.map((inquiry) => `
    <article class="rounded-xl border border-white/10 p-4">
      <p class="text-sm font-bold text-bytezone-mint">${money(inquiry.packagePriceMwk)} · ${new Date(inquiry.createdAt).toLocaleString()}</p>
      <p class="mt-2 text-sm">Customer ${escapeHtml(inquiry.customerId.slice(0, 8))}</p>
      <p class="mt-1 text-sm text-slate-300">Contact: ${escapeHtml(inquiry.contact)}</p>
      <p class="mt-1 text-sm text-slate-400">${escapeHtml(inquiry.message || "No additional message.")}</p>
    </article>`).join("") || '<p class="text-sm text-slate-400">No package inquiries yet.</p>';
}

async function loadBiometricStatus() {
  const status = await request("/api/biometrics/status");
  state.scannerAvailable = status.scannerAvailable;
  state.biometricEnrolled = status.enrolled;
  byId("biometric-status").textContent = `Fingerprint ${status.enrolled ? "enrolled" : "not enrolled"} · Scanner ${status.scannerAvailable ? "available" : "unavailable; password fallback active"}`;
}

function confirmSensitiveAction(label) {
  if (state.scannerAvailable && state.biometricEnrolled && window.confirm(`${label}: verify with fingerprint? Select Cancel to use your password.`)) {
    return { useBiometric: true };
  }
  const password = window.prompt(`${label}: enter your password to confirm.`);
  return password === null ? null : { password, useBiometric: false };
}

async function refreshAll() {
  try {
    await loadDevices();
    const adminTasks = isAdmin() ? [loadAdminDashboard(), loadCustomers(), loadSales()] : [];
    await Promise.all([loadRentals(), loadInventory(), loadTickets(), loadInquiries(), loadBiometricStatus(), ...adminTasks]);
  } catch (error) {
    notify(error.message, true);
  }
}

function openReceipt(receipt) {
  const lines = receipt.items.map((item) => `<tr><td>${escapeHtml(item.name)} × ${item.quantity}</td><td>${money(item.lineTotalMwk)}</td></tr>`).join("");
  const receiptWindow = window.open("", "_blank", "width=420,height=650");
  if (!receiptWindow) {
    notify("Allow pop-ups to print the receipt.", true);
    return;
  }
  receiptWindow.document.write(`<!doctype html><title>ByteZone receipt</title><style>body{font:14px Arial;padding:24px;color:#111}table{width:100%;border-collapse:collapse}td{padding:9px 0;border-bottom:1px solid #ddd}td:last-child{text-align:right}h1{text-align:center}.total{font-weight:bold;text-align:right}</style><h1>ByteZone</h1><p>Receipt ${escapeHtml(receipt.id)}</p><p>${new Date(receipt.createdAt).toLocaleString()}</p><table>${lines}</table><p class="total">Total ${money(receipt.totalMwk)}</p><p>Payment: ${escapeHtml(receipt.paymentMethod)}</p>`);
  receiptWindow.document.close();
  receiptWindow.print();
}

byId("register-toggle").addEventListener("click", () => {
  state.register = !state.register;
  byId("name-field").classList.toggle("hidden", !state.register);
  byId("phone-field").classList.toggle("hidden", !state.register);
  byId("auth-form").querySelector('[name="name"]').required = state.register;
  byId("auth-form").querySelector('[name="password"]').autocomplete = state.register ? "new-password" : "current-password";
  byId("auth-form").querySelector('button[type="submit"]').textContent = state.register ? "Create account" : "Sign in";
  byId("register-toggle").textContent = state.register ? "Already registered? Sign in" : "Create a customer account";
});

byId("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.useBiometric = form.has("useBiometric");
  if (state.register) body.useBiometric = false;
  if (body.useBiometric) body.password = "";
  try {
    const result = await request(state.register ? "/api/auth/register" : "/api/auth/login", { method: "POST", body: jsonBody(body) });
    finishLogin(result);
  } catch (error) {
    if (body.useBiometric && !error.message.includes("Fingerprint did not match")) {
      const password = window.prompt("Scanner unavailable. Enter your password to continue:");
      if (password) {
        try {
          body.password = password;
          body.useBiometric = false;
          const result = await request("/api/auth/login", { method: "POST", body: jsonBody(body) });
          state.user = result.user;
          csrfToken = result.csrfToken;
          showWorkspace();
          notify(`Welcome, ${state.user.profile.name}.`);
          return;
        } catch (fallbackError) { notify(fallbackError.message, true); return; }
      }
    }
    notify(error.message, true);
  }
});

byId("logout-button").addEventListener("click", async () => {
  try {
    await request("/api/auth/logout", { method: "POST" });
    state.user = null;
    state.cart.clear();
    const csrf = await fetch("/api/csrf", { credentials: "same-origin" });
    csrfToken = (await csrf.json()).csrfToken;
    showWorkspace();
  } catch (error) { notify(error.message, true); }
});

byId("rental-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  body.depositMwk = Number(body.depositMwk || 0);
  body.expectedReturnAt = new Date(body.expectedReturnAt).toISOString();
  if (body.depositMwk > 0) {
    const verification = confirmSensitiveAction("Confirm deposit");
    if (!verification) return;
    Object.assign(body, verification);
  }
  try {
    await request("/api/rentals", { method: "POST", body: jsonBody(body) });
    event.currentTarget.reset();
    notify("Device checked out. Billing is running.");
    await refreshAll();
  } catch (error) { notify(error.message, true); }
});

byId("biometric-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request("/api/biometrics/enroll", { method: "POST", body: jsonBody(Object.fromEntries(new FormData(event.currentTarget).entries())) });
    event.currentTarget.reset();
    notify("Fingerprint enrolled securely.");
    await loadBiometricStatus();
  } catch (error) { notify(error.message, true); }
});

byId("ticket-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await request("/api/tickets", { method: "POST", body: form });
    event.currentTarget.reset();
    notify(`Request submitted: ${result.ticket.id.slice(0, 8)}.`);
    await loadTickets();
  } catch (error) { notify(error.message, true); }
});

byId("device-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  body.rateMwk = Number(body.rateMwk);
  try {
    await request("/api/devices", { method: "POST", body: jsonBody(body) });
    event.currentTarget.reset();
    await loadDevices();
    notify("Device added.");
  } catch (error) { notify(error.message, true); }
});

byId("inventory-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  body.priceMwk = Number(body.priceMwk);
  body.quantity = Number(body.quantity);
  try {
    await request("/api/inventory", { method: "POST", body: jsonBody(body) });
    event.currentTarget.reset();
    await loadInventory();
    notify("Inventory item added.");
  } catch (error) { notify(error.message, true); }
});

byId("barcode-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const barcode = new FormData(event.currentTarget).get("barcode").trim();
  const item = state.inventory.find((candidate) => candidate.barcode === barcode && candidate.quantity > 0);
  if (!item) return notify("No in-stock item matches that barcode.", true);
  addToCart(item);
  event.currentTarget.reset();
  byId("barcode-input").focus();
});

function addToCart(item) {
  const existing = state.cart.get(item.id);
  if ((existing?.quantity || 0) >= item.quantity) return notify("Cannot add more than the available stock.", true);
  state.cart.set(item.id, { id: item.id, name: item.name, price_mwk: item.price_mwk, quantity: (existing?.quantity || 0) + 1 });
  drawCart();
}

byId("checkout-button").addEventListener("click", async () => {
  if (!state.cart.size) return notify("Add an item before checkout.", true);
  const verification = confirmSensitiveAction("Confirm sale");
  if (!verification) return;
  const paymentMethod = window.prompt("Payment method: cash, mobile money, or card", "cash");
  if (!paymentMethod) return;
  try {
    const { receipt } = await request("/api/sales", {
      method: "POST",
      body: jsonBody({ items: [...state.cart.values()].map(({ id, quantity }) => ({ id, quantity })), paymentMethod: paymentMethod.toLowerCase(), ...verification }),
    });
    state.cart.clear();
    drawCart();
    openReceipt(receipt);
    notify(`Sale complete · ${money(receipt.totalMwk)}.`);
    await loadInventory();
  } catch (error) { notify(error.message, true); }
});

byId("report-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const date = new FormData(event.currentTarget).get("date");
  try {
    const report = await request(`/api/sales/report${date ? `?date=${encodeURIComponent(date)}` : ""}`);
    byId("sales-report").innerHTML = `<p>${escapeHtml(report.date)} · ${report.saleCount} sales · <strong class="text-bytezone-mint">${money(report.totalMwk)}</strong></p>
      ${report.sales.map((sale) => `<p class="mt-2 border-t border-white/10 pt-2">${new Date(sale.createdAt).toLocaleTimeString()} · ${money(sale.totalMwk)} · ${escapeHtml(sale.paymentMethod)}</p>`).join("")}`;
  } catch (error) { notify(error.message, true); }
});

byId("buy-pos-button").addEventListener("click", () => byId("pos-inquiry-form").classList.toggle("hidden"));
byId("pos-inquiry-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await request("/api/pos-inquiries", { method: "POST", body: jsonBody(Object.fromEntries(new FormData(event.currentTarget).entries())) });
    event.currentTarget.reset();
    notify(`Payment inquiry received. Package price: ${money(result.packagePriceMwk)}.`);
  } catch (error) { notify(error.message, true); }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button, select");
  if (!target) return;
  try {
    if (target.dataset.addItem) {
      const item = state.inventory.find((candidate) => candidate.id === target.dataset.addItem);
      if (item) addToCart(item);
    }
    if (target.dataset.removeItem) {
      state.cart.delete(target.dataset.removeItem);
      drawCart();
    }
    if (target.dataset.returnRental) {
      const verification = confirmSensitiveAction("Confirm return and payment");
      if (!verification) return;
      const rental = (await request("/api/rentals")).rentals.find((item) => item.id === target.dataset.returnRental);
      const depositDisposition = rental?.depositMwk ? window.prompt("Deposit disposition: refunded or applied", "refunded") : undefined;
      if (rental?.depositMwk && !["refunded", "applied"].includes(depositDisposition)) return notify("Choose refunded or applied.", true);
      const result = await request(`/api/rentals/${encodeURIComponent(target.dataset.returnRental)}/return`, {
        method: "POST", body: jsonBody({ ...verification, depositDisposition }),
      });
      notify(`Returned. Total ${money(result.totalMwk)} · remaining balance ${money(result.balanceMwk)} · deposit refund ${money(result.depositRefundMwk)}.`);
      await refreshAll();
    }
    if (target.dataset.payRental) {
      const verification = confirmSensitiveAction("Confirm payment");
      if (!verification) return;
      const amountMwk = Number(window.prompt("Amount received (MWK):"));
      const paymentMethod = window.prompt("Payment method: cash, mobile money, or card", "cash");
      if (!amountMwk || !paymentMethod) return;
      await request(`/api/rentals/${encodeURIComponent(target.dataset.payRental)}/payment`, {
        method: "POST", body: jsonBody({ ...verification, amountMwk, paymentMethod: paymentMethod.toLowerCase() }),
      });
      notify("Payment recorded.");
      await loadRentals();
    }
    if (target.dataset.deviceStatus) {
      await request(`/api/devices/${encodeURIComponent(target.dataset.deviceStatus)}`, {
        method: "PATCH", body: jsonBody({ status: target.value }),
      });
      notify("Device status updated.");
      await loadDevices();
    }
    if (target.dataset.ticketStatus) {
      await request(`/api/tickets/${encodeURIComponent(target.dataset.ticketStatus)}`, {
        method: "PATCH", body: jsonBody({ status: target.value }),
      });
      notify("Ticket status updated.");
      await Promise.all([loadTickets(), loadAdminDashboard()]);
    }
    if (target.dataset.ticketDecision) {
      await request(`/api/tickets/${encodeURIComponent(target.dataset.ticketId)}`, {
        method: "PATCH", body: jsonBody({ status: target.dataset.ticketDecision }),
      });
      notify(`Removal request ${target.dataset.ticketDecision.toLowerCase()}.`);
      await Promise.all([loadTickets(), loadAdminDashboard()]);
    }
    if (target.dataset.refresh === "rentals") await loadRentals();
    if (target.dataset.refresh === "inventory") await loadInventory();
    if (target.dataset.refresh === "tickets") await loadTickets();
    if (target.dataset.refresh === "inquiries") await loadInquiries();
    if (target.dataset.refresh === "customers") await loadCustomers();
    if (target.dataset.refresh === "sales") await loadSales();
  } catch (error) { notify(error.message, true); }
});

document.addEventListener("submit", async (event) => {
  const deviceForm = event.target.closest("form[data-edit-device]");
  const itemForm = event.target.closest("form[data-edit-item]");
  const customerForm = event.target.closest("form[data-edit-customer]");
  if (!deviceForm && !itemForm && !customerForm) return;
  event.preventDefault();
  try {
    if (customerForm) {
      const values = Object.fromEntries(new FormData(customerForm).entries());
      await request(`/api/customers/${encodeURIComponent(customerForm.dataset.editCustomer)}`, {
        method: "PATCH", body: jsonBody(values),
      });
      notify("Customer details updated.");
      await loadCustomers();
    } else if (deviceForm) {
      const values = Object.fromEntries(new FormData(deviceForm).entries());
      await request(`/api/devices/${encodeURIComponent(deviceForm.dataset.editDevice)}`, {
        method: "PATCH", body: jsonBody({ rateMwk: Number(values.rateMwk), status: values.status }),
      });
      notify("Device pricing and status updated.");
      await loadDevices();
    } else {
      const values = Object.fromEntries(new FormData(itemForm).entries());
      await request(`/api/inventory/${encodeURIComponent(itemForm.dataset.editItem)}`, {
        method: "PATCH", body: jsonBody({ priceMwk: Number(values.priceMwk), quantity: Number(values.quantity) }),
      });
      notify("Inventory updated.");
      await loadInventory();
    }
  } catch (error) { notify(error.message, true); }
});

byId("auth-form").elements.useBiometric.addEventListener("change", (event) => {
  byId("auth-form").elements.password.required = state.register || !event.target.checked;
});

async function initialize() {
  try {
    const csrf = await fetch("/api/csrf", { credentials: "same-origin" });
    csrfToken = (await csrf.json()).csrfToken;
    try {
      const googleStatusResponse = await fetch("/api/auth/google/status", { credentials: "same-origin" });
      const googleStatus = await googleStatusResponse.json();
      const googleEnabled = googleStatusResponse.ok && googleStatus.enabled === true;
      if (!googleEnabled) throw new Error("Google sign-in is not configured for this site yet.");
      await loadGoogleIdentityServices();
      window.google.accounts.id.initialize({
        client_id: googleStatus.clientId,
        nonce: googleStatus.nonce,
        callback: async ({ credential }) => {
          try {
            const result = await request("/api/auth/google/credential", {
              method: "POST",
              body: jsonBody({ credential }),
            });
            csrfToken = result.csrfToken;
            window.location.assign("/ops");
          } catch (error) {
            notify(error.message, true);
          }
        },
      });
      window.google.accounts.id.renderButton(byId("google-signin-button"), {
        type: "standard",
        theme: "outline",
        size: "large",
        text: "continue_with",
        shape: "rectangular",
        width: 360,
      });
      byId("google-signin-status").textContent = "Sign in or create a customer account with Google.";
    } catch (error) {
      byId("google-signin-status").textContent = error.message || "Google sign-in is currently unavailable.";
    }
    try {
      const { user } = await request("/api/me");
      state.user = user;
    } catch (error) {
      if (!error.message.includes("Sign in") && !error.message.includes("expired")) throw error;
    }
    showWorkspace();
    const defaultReturn = new Date(Date.now() + 60 * 60 * 1000);
    defaultReturn.setMinutes(defaultReturn.getMinutes() - defaultReturn.getTimezoneOffset());
    byId("expected-return").value = defaultReturn.toISOString().slice(0, 16);
  } catch (error) {
    notify(error.message, true);
  }
}

initialize();
window.setInterval(() => {
  if (isStaff()) loadRentals().catch((error) => notify(error.message, true));
}, 60000);
