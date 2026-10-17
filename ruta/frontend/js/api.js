/**
 * Capa de acceso al backend.
 *
 * Lecturas:  red primero; si no hay red, la última copia guardada en IndexedDB.
 *            Devuelven { data, fromCache, savedAt }.
 * Escrituras: si hay red y la cola está vacía, van directo. Si no, se encolan
 *            (así nunca se adelantan a acciones pendientes más viejas).
 *            Devuelven { status: "synced", data } o { status: "queued", tempId }.
 *            Lanzan ApiError solo si el servidor rechazó los datos (4xx).
 */
import { idb, STORES } from "./db.js";
import {
  enqueue, isRetryable, newIdempotencyKey, newTempId, pendingCount, requestHeaders,
} from "./sync.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function get(path) {
  try {
    const res = await fetch(path, { headers: requestHeaders() });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new ApiError(res.status, detail.error || `Error ${res.status}`);
    }
    const data = await res.json();
    await idb.put(STORES.cache, { key: path, data, savedAt: Date.now() });
    return { data, fromCache: false, savedAt: Date.now() };
  } catch (err) {
    if (err instanceof ApiError && !isRetryable(err.status)) throw err;
    const cached = await idb.get(STORES.cache, path);
    if (cached) return { data: cached.data, fromCache: true, savedAt: cached.savedAt };
    throw err;
  }
}

async function write(method, path, body, { createsEntity = false } = {}) {
  const idempotencyKey = newIdempotencyKey();
  const tempId = createsEntity ? newTempId() : null;

  if (navigator.onLine && (await pendingCount()) === 0) {
    let res = null;
    try {
      res = await fetch(path, { method, headers: requestHeaders(idempotencyKey), body: JSON.stringify(body) });
    } catch {
      // La red se cayó a medio camino. Quizá el servidor sí lo guardó:
      // se encola con la MISMA clave y el reintento no duplicará nada.
    }
    if (res?.ok) return { status: "synced", data: await res.json() };
    if (res && !isRetryable(res.status)) {
      const detail = await res.json().catch(() => ({}));
      throw new ApiError(res.status, detail.error || `Error ${res.status}`);
    }
  }

  await enqueue({ method, url: path, body, idempotencyKey, tempId });
  return { status: "queued", tempId };
}

/** Actualiza una lista en caché, p. ej. para mostrar una tienda creada offline. */
export async function patchCache(path, update) {
  const cached = await idb.get(STORES.cache, path);
  if (cached) await idb.put(STORES.cache, { ...cached, data: update(cached.data) });
}

const now = () => new Date().toISOString();

export const api = {
  // Lecturas
  products: () => get("/api/products"),
  stores: () => get("/api/stores"),
  employees: () => get("/api/employees"),
  vehicles: () => get("/api/vehicles"),
  mermas: () => get("/api/merma"),
  dashboard: ({ period = "day", date, from, to, employeeId } = {}) => {
    const q = new URLSearchParams({ period });
    if (date) q.set("date", date);
    if (from && to) { q.set("from", from); q.set("to", to); }
    if (employeeId) q.set("employee_id", employeeId);
    return get(`/api/dashboard/summary?${q}`);
  },

  // Transacciones: occurred_at se fija al momento real, no al de sincronización
  createSale: (sale) => write("POST", "/api/sales", { occurred_at: now(), ...sale }),
  createPayment: (payment) => write("POST", "/api/sales/payments", { occurred_at: now(), ...payment }),
  createMerma: (merma) => write("POST", "/api/merma", { occurred_at: now(), ...merma }),

  // Datos maestros
  createStore: (store) => write("POST", "/api/stores", store, { createsEntity: true }),
  updateStore: (id, store) => write("PUT", `/api/stores/${id}`, store),
  createProduct: (product) => write("POST", "/api/products", product, { createsEntity: true }),
  updateProduct: (id, product) => write("PUT", `/api/products/${id}`, product),
  createEmployee: (employee) => write("POST", "/api/employees", employee, { createsEntity: true }),
  createVehicle: (vehicle) => write("POST", "/api/vehicles", vehicle, { createsEntity: true }),
};
