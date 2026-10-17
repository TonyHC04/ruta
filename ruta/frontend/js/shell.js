/**
 * Punto de entrada: navegación por hash, permisos por rol, indicador de
 * sincronización y panel de envíos rechazados.
 *
 * La lógica de cada pantalla vive en views.js; el resumen, en dashboard.js.
 */
import { discardFailed, flushQueue, listFailed, onSyncChange, retryFailed, startSync } from "./sync.js";
import { initDashboard, loadDashboard } from "./dashboard.js";
import { initViews, viewLoaders } from "./views.js";

const ACTION_LABELS = {
  "/api/sales": "Venta",
  "/api/sales/payments": "Abono",
  "/api/merma": "Merma",
  "/api/stores": "Tienda",
  "/api/products": "Producto",
};

const views = document.querySelectorAll("[data-view]");
const navLinks = document.querySelectorAll("[data-nav]");

// ------------------------------------------------------------ roles
// Hasta que exista login, el rol se toma de <body data-role="...">.
function applyRole(role) {
  document.querySelectorAll("[data-roles]").forEach((node) => {
    node.hidden = !node.dataset.roles.split(" ").includes(role);
  });
}

// ------------------------------------------------------------ navegación
function currentView() {
  const name = location.hash.slice(1);
  const visible = [...navLinks].filter((a) => !a.closest("[hidden]")).map((a) => a.dataset.nav);
  return visible.includes(name) ? name : visible[0];
}

function show(name) {
  views.forEach((v) => (v.hidden = v.dataset.view !== name));
  navLinks.forEach((a) => (a.dataset.nav === name
    ? a.setAttribute("aria-current", "page")
    : a.removeAttribute("aria-current")));
  if (name === "resumen") loadDashboard();
  if (name === "pendientes") renderFailed();
  viewLoaders[name]?.();
}

// ------------------------------------------------------------ indicador
function renderSyncState({ pending, failed, online, syncing }) {
  const pill = document.getElementById("sync-status");
  let state = "ok";
  let text = "Todo enviado";
  if (!online) {
    state = "offline";
    text = pending ? `Sin conexión, ${pending} por enviar` : "Sin conexión";
  } else if (syncing || pending) {
    state = "syncing";
    text = pending ? `Enviando ${pending}…` : "Enviando…";
  } else if (failed) {
    state = "failed";
    text = `${failed} ${failed === 1 ? "envío rechazado" : "envíos rechazados"}`;
  }
  pill.dataset.state = state;
  pill.querySelector(".sync-text").textContent = text;
  pill.disabled = state === "ok" || state === "offline";

  document.querySelectorAll("[data-failed-count]").forEach((badge) => {
    badge.textContent = failed;
    badge.hidden = failed === 0;
  });
}

// ------------------------------------------------------------ rechazados
async function renderFailed() {
  const list = document.getElementById("failed-list");
  const items = await listFailed();
  document.getElementById("failed-empty").hidden = items.length > 0;

  list.replaceChildren(...items.map((a) => {
    const li = document.createElement("li");
    li.className = "failed-item";
    const when = new Date(a.createdAt).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
    const title = document.createElement("strong");
    title.textContent = `${ACTION_LABELS[a.url.split("?")[0]] ?? a.url}, ${when}`;
    const reason = document.createElement("p");
    reason.textContent = a.lastError;

    const retry = button("Reintentar", "btn btn--small", async () => {
      await retryFailed(a.seq);
      renderFailed();
    });
    const discard = button("Descartar", "btn btn--small btn--ghost", async () => {
      if (!confirm("Esta acción no se enviará nunca. ¿Descartarla?")) return;
      await discardFailed(a.seq);
      renderFailed();
    });
    const actions = document.createElement("div");
    actions.className = "failed-actions";
    actions.append(retry, discard);
    li.append(title, reason, actions);
    return li;
  }));
}

function button(label, className, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// ------------------------------------------------------------ arranque
applyRole(document.body.dataset.role || "admin");
initDashboard();
initViews();
window.addEventListener("hashchange", () => show(currentView()));
window.addEventListener("sync:drained", () => show(currentView()));   // recarga datos frescos
document.getElementById("sync-status").addEventListener("click", (e) => {
  if (e.currentTarget.dataset.state === "failed") location.hash = "pendientes";
  else flushQueue();
});
onSyncChange(renderSyncState);
show(currentView());
startSync();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}
