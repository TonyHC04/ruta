/**
 * Cola de sincronización offline-first.
 *
 * Garantías:
 *  1. No duplica: cada acción lleva una Idempotency-Key fija desde que se crea.
 *     Si la red se cae con la petición en vuelo, el reintento usa la misma
 *     clave y el servidor devuelve la respuesta original.
 *  2. Respeta el orden: se envía en secuencia (venta antes que su abono). Un
 *     error temporal detiene la cola en esa acción y reintenta con backoff.
 *  3. No se bloquea para siempre: si el servidor rechaza una acción (4xx), se
 *     mueve a "failed_actions" para revisarla a mano y la cola sigue.
 *  4. IDs temporales: algo creado offline (una tienda nueva) recibe un ID
 *     negativo. Al sincronizar se guarda temp -> real y se reescriben las
 *     acciones siguientes que lo usan (store_id: -171..., /api/stores/-171...).
 *
 * Eventos en window:
 *  - "sync:applied" { action, data }  una acción llegó al servidor
 *  - "sync:drained"                   la cola quedó vacía
 */
import { idb, STORES } from "./db.js";

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
const PERIODIC_CHECK_MS = 60_000;
const LEGACY_QUEUE_KEY = "pending_actions_v1";   // cola vieja en localStorage

let getExtraHeaders = () => ({});
let flushing = null;
let retryTimer = null;
const listeners = new Set();

/** Permite inyectar el token de sesión cuando exista autenticación. */
export function configureSync({ headers } = {}) {
  if (headers) getExtraHeaders = headers;
}

export function requestHeaders(idempotencyKey) {
  return {
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    ...getExtraHeaders(),
  };
}

/**
 * 408, 429 y 5xx son temporales. 401 también: la venta es válida, solo hay
 * que volver a iniciar sesión, así que no se descarta.
 */
export function isRetryable(status) {
  return status === 401 || status === 408 || status === 429 || status >= 500;
}

export function newIdempotencyKey() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let lastTempId = 0;
export function newTempId() {
  lastTempId = Math.max(Date.now(), lastTempId + 1);
  return -lastTempId;
}

// ------------------------------------------------------------------ estado

export function onSyncChange(fn) {
  listeners.add(fn);
  emit();
  return () => listeners.delete(fn);
}

async function emit() {
  const [pending, failed] = await Promise.all([idb.count(STORES.queue), idb.count(STORES.failed)]);
  const state = { pending, failed, online: navigator.onLine, syncing: Boolean(flushing) };
  listeners.forEach((fn) => fn(state));
}

export const pendingCount = () => idb.count(STORES.queue);

// ------------------------------------------------------------------ cola

/**
 * Encola una escritura. `idempotencyKey` debe ser la misma que se usó si ya
 * se intentó enviar directo (api.js lo hace así).
 */
export async function enqueue({ method, url, body = null, idempotencyKey, tempId = null }) {
  const action = {
    method, url, body, tempId,
    idempotencyKey: idempotencyKey || newIdempotencyKey(),
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  };
  action.seq = await idb.put(STORES.queue, action);
  emit();
  if (navigator.onLine) flushQueue();
  return action;
}

/** Vacía la cola en orden. Llamadas concurrentes comparten la misma ejecución. */
export function flushQueue() {
  if (flushing) return flushing;
  flushing = drain().finally(() => { flushing = null; emit(); });
  emit();
  return flushing;
}

async function drain() {
  clearTimeout(retryTimer);
  let sentSomething = false;

  while (navigator.onLine) {
    const [next] = await idb.getAll(STORES.queue);
    if (!next) break;

    const wait = next.nextAttemptAt - Date.now();
    if (wait > 0) { scheduleRetry(wait); return; }

    const outcome = await send(next);

    if (outcome.kind === "done") {
      await idb.delete(STORES.queue, next.seq);
      sentSomething = true;
      window.dispatchEvent(new CustomEvent("sync:applied", { detail: { action: next, data: outcome.data } }));
    } else if (outcome.kind === "rejected") {
      await idb.move(STORES.queue, STORES.failed, next.seq, (a) => ({
        ...a, lastError: outcome.error, status: outcome.status, failedAt: new Date().toISOString(),
      }));
    } else {
      next.attempts += 1;
      next.lastError = outcome.error;
      next.nextAttemptAt = Date.now() + backoff(next.attempts);
      await idb.put(STORES.queue, next);
      scheduleRetry(next.nextAttemptAt - Date.now());
      return;
    }
    emit();
  }

  if (sentSomething && (await pendingCount()) === 0) {
    window.dispatchEvent(new CustomEvent("sync:drained"));
  }
}

async function send(action) {
  const idMap = await getIdMap();
  const url = rewriteUrl(action.url, idMap);
  const body = rewriteIds(action.body, idMap);

  let res;
  try {
    res = await fetch(url, {
      method: action.method,
      headers: requestHeaders(action.idempotencyKey),
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch {
    return { kind: "retry", error: "Sin conexión con el servidor" };
  }

  if (res.ok) {
    const data = await res.json().catch(() => null);
    if (action.tempId != null && data?.id != null) await saveIdMapping(action.tempId, data.id);
    return { kind: "done", data };
  }
  if (isRetryable(res.status)) {
    return { kind: "retry", error: res.status === 401 ? "Sesión vencida" : `Servidor respondió ${res.status}` };
  }
  const detail = await res.json().catch(() => ({}));
  return { kind: "rejected", status: res.status, error: detail.error || `Rechazado (${res.status})` };
}

function backoff(attempts) {
  const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
  return exp / 2 + Math.random() * (exp / 2);   // jitter: no reintentan todos a la vez
}

function scheduleRetry(ms) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(flushQueue, Math.max(ms, 500));
}

// ------------------------------------------------------------------ IDs temporales

async function getIdMap() {
  return (await idb.get(STORES.meta, "id_map"))?.value ?? {};
}

async function saveIdMapping(tempId, realId) {
  const map = await getIdMap();
  map[tempId] = realId;
  await idb.put(STORES.meta, { key: "id_map", value: map });
}

function rewriteIds(value, map) {
  if (Array.isArray(value)) return value.map((v) => rewriteIds(v, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      const isRef = (k === "id" || k.endsWith("_id")) && typeof v === "number" && v < 0;
      return [k, isRef && map[v] != null ? map[v] : rewriteIds(v, map)];
    }));
  }
  return value;
}

function rewriteUrl(url, map) {
  return url.replace(/\/(-\d+)(?=\/|\?|$)/g, (m, id) => (map[id] != null ? `/${map[id]}` : m));
}

// ------------------------------------------------------------------ rechazadas

export const listFailed = () => idb.getAll(STORES.failed);

/** Devuelve la acción a la cola en su posición original y con la misma clave. */
export async function retryFailed(seq, patchedBody) {
  await idb.move(STORES.failed, STORES.queue, seq, (a) => ({
    ...a, body: patchedBody ?? a.body, attempts: 0, nextAttemptAt: 0, lastError: null,
  }));
  emit();
  return flushQueue();
}

export async function discardFailed(seq) {
  await idb.delete(STORES.failed, seq);
  emit();
}

// ------------------------------------------------------------------ arranque

/** Importa una sola vez la cola vieja de localStorage (versión anterior de api.js). */
async function migrateLegacyQueue() {
  let legacy;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_QUEUE_KEY) || "[]"); } catch { legacy = []; }
  for (const a of legacy) {
    const url = a.url ?? a.path;
    if (a.method && url) await idb.put(STORES.queue, {
      method: a.method, url, body: a.body ?? a.data ?? null, tempId: null,
      idempotencyKey: newIdempotencyKey(), createdAt: new Date().toISOString(),
      attempts: 0, nextAttemptAt: 0, lastError: null,
    });
  }
  localStorage.removeItem(LEGACY_QUEUE_KEY);
}

export async function startSync() {
  await migrateLegacyQueue();
  window.addEventListener("online", flushQueue);
  window.addEventListener("offline", emit);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flushQueue();
  });
  setInterval(async () => {
    if (navigator.onLine && (await pendingCount()) > 0) flushQueue();
  }, PERIODIC_CHECK_MS);
  emit();
  if (navigator.onLine) flushQueue();
}
