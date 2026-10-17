/**
 * Lógica de las pantallas: Vender, Cobranza, Inventario, Tiendas, Merma y Equipo.
 *
 * Cada escritura pasa por api.js: si no hay señal se guarda en el celular y se
 * refleja al momento en las listas (marcada "por enviar") para que el
 * repartidor vea su inventario y saldos al día aunque siga sin conexión.
 */
import { api, patchCache } from "./api.js";
import { scanBarcode, scannerUnavailableReason } from "./scanner.js";
import { $, el, fillRows, mxn, openForm, reportWrite, shortDate, toast } from "./ui.js";

const REASONS = [
  { value: "danado", label: "Dañado" },
  { value: "caducado", label: "Caducado" },
  { value: "devolucion", label: "Devolución" },
  { value: "otro", label: "Otro" },
];
const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.value, r.label]));
const EMPLOYEE_KEY = "rm_repartidor";

const cache = { products: [], stores: [], employees: [], vehicles: [], mermas: [] };

async function load(name) {
  try {
    cache[name] = (await api[name]()).data;
  } catch (err) {
    toast(`No se pudo cargar la información (${err.message}). Revisa la conexión.`, "error");
  }
  return cache[name];
}

const pendingTag = (row) => row.pending && el("span", { class: "tag" }, "por enviar");
const clean = (values) => Object.fromEntries(Object.entries(values)
  .map(([k, v]) => [k, typeof v === "string" ? (v.trim() || null) : v]));
const currentEmployee = () => Number(localStorage.getItem(EMPLOYEE_KEY)) || null;

// ================================================================ Inventario

async function loadInventory() {
  await load("products");
  renderInventory();
}

function renderInventory() {
  const q = $("#product-search").value.trim().toLowerCase();
  const rows = cache.products.filter((p) =>
    !q || p.name.toLowerCase().includes(q) || (p.barcode || "").includes(q));
  const canEdit = !$("#btn-new-product").hidden;
  fillRows("#tbl-products", rows, (p) => [
    ["Producto", [p.name, pendingTag(p)]],
    ["Código", p.barcode || "—"],
    ["Costo", mxn(p.cost_price), "num"],
    ["Precio", mxn(p.sale_price), "num"],
    ["Stock", p.stock, p.stock < 0 ? "num neg" : "num"],
  ], q ? "Ningún producto coincide con la búsqueda."
    : "Aún no hay productos. Agrega el primero con «Agregar producto».",
  canEdit ? editProduct : null);
}

const productFields = (p = {}) => [
  { name: "name", label: "Nombre", required: true, value: p.name },
  { name: "barcode", label: "Código de barras", value: p.barcode, inputmode: "numeric" },
  { name: "cost_price", label: "Costo", type: "number", step: "0.01", min: "0", required: true, inputmode: "decimal", value: p.cost_price },
  { name: "sale_price", label: "Precio de venta", type: "number", step: "0.01", min: "0", required: true, inputmode: "decimal", value: p.sale_price },
  { name: "stock", label: p.id ? "Stock actual" : "Stock inicial", type: "number", step: "1", required: true, value: p.stock ?? 0 },
];

function productBody(v) {
  if (Number(v.sale_price) < Number(v.cost_price)) {
    // Se permite (promociones), pero se avisa por si fue un error de dedo.
    toast("Ojo: el precio de venta es menor que el costo.", "warn");
  }
  return { ...clean(v), stock: parseInt(v.stock, 10) || 0 };
}

export function newProduct(prefill = {}) {
  return openForm({
    title: "Agregar producto",
    fields: productFields(prefill),
    submitLabel: "Guardar producto",
    onSubmit: async (v) => {
      const body = productBody(v);
      const r = await api.createProduct(body);
      if (r.status === "queued") {
        await patchCache("/api/products", (list) =>
          [...list, { ...body, id: r.tempId, store_prices: {}, pending: true }]);
      }
      reportWrite(r, "Producto guardado");
      await loadInventory();
    },
  });
}

function editProduct(p) {
  return openForm({
    title: `Editar ${p.name}`,
    fields: productFields(p),
    submitLabel: "Guardar cambios",
    onSubmit: async (v) => {
      const body = productBody(v);
      const r = await api.updateProduct(p.id, body);
      if (r.status === "queued") {
        await patchCache("/api/products", (list) =>
          list.map((x) => (x.id === p.id ? { ...x, ...body, pending: true } : x)));
      }
      reportWrite(r, "Cambios guardados");
      await loadInventory();
    },
  });
}

// ================================================================ Tiendas

async function loadStores() {
  await load("stores");
  fillRows("#tbl-stores", cache.stores, (s) => [
    ["Tienda", [s.name, pendingTag(s)]],
    ["Encargado", s.owner_name || "—"],
    ["Teléfono", s.phone ? el("a", { href: `tel:${s.phone}` }, s.phone) : "—"],
    ["Saldo", mxn(s.balance), "num"],
  ], "Aún no hay tiendas. Agrega la primera con «Agregar tienda».", editStore);
}

const storeFields = (s = {}) => [
  { name: "name", label: "Nombre de la tienda", required: true, value: s.name },
  { name: "owner_name", label: "Encargado", value: s.owner_name },
  { name: "phone", label: "Teléfono", type: "tel", inputmode: "tel", value: s.phone },
  { name: "address", label: "Dirección", type: "textarea", value: s.address },
];

function newStore() {
  return openForm({
    title: "Agregar tienda",
    fields: storeFields(),
    submitLabel: "Guardar tienda",
    onSubmit: async (v) => {
      const body = clean(v);
      const r = await api.createStore(body);
      if (r.status === "queued") {
        await patchCache("/api/stores", (list) =>
          [...list, { ...body, id: r.tempId, balance: "0.00", last_payment_at: null, pending: true }]);
      }
      reportWrite(r, "Tienda guardada");
      await loadStores();
    },
  });
}

function editStore(s) {
  return openForm({
    title: `Editar ${s.name}`,
    fields: storeFields(s),
    submitLabel: "Guardar cambios",
    onSubmit: async (v) => {
      const body = clean(v);
      const r = await api.updateStore(s.id, body);
      if (r.status === "queued") {
        await patchCache("/api/stores", (list) =>
          list.map((x) => (x.id === s.id ? { ...x, ...body, pending: true } : x)));
      }
      reportWrite(r, "Cambios guardados");
      await loadStores();
    },
  });
}

// ================================================================ Cobranza

async function loadCobranza() {
  await load("stores");
  const owing = cache.stores
    .filter((s) => Number(s.balance) >= 0.01)
    .sort((a, b) => Number(b.balance) - Number(a.balance));
  fillRows("#tbl-cobranza", owing, (s) => [
    ["Tienda", [s.name, pendingTag(s)]],
    ["Saldo", mxn(s.balance), "num"],
    ["Último abono", shortDate(s.last_payment_at), "num"],
    ["", el("button", { type: "button", class: "btn btn--small", onclick: () => registerPayment(s) }, "Registrar abono")],
  ], "Ninguna tienda tiene saldo pendiente.");
}

function registerPayment(store) {
  return openForm({
    title: `Abono de ${store.name}`,
    fields: [
      { name: "amount", label: "Monto recibido", type: "number", step: "0.01", min: "0.01", required: true,
        inputmode: "decimal", hint: `Saldo actual: ${mxn(store.balance)}` },
      { name: "method", label: "Forma de pago", type: "select", value: "efectivo",
        options: [{ value: "efectivo", label: "Efectivo" }, { value: "transferencia", label: "Transferencia" }] },
    ],
    submitLabel: "Registrar abono",
    onSubmit: async (v) => {
      const amount = Number(v.amount);
      if (!(amount > 0)) throw new Error("Escribe un monto mayor a cero.");
      const r = await api.createPayment({
        store_id: store.id, amount: amount.toFixed(2), method: v.method, employee_id: currentEmployee(),
      });
      if (r.status === "queued") {
        await patchCache("/api/stores", (list) => list.map((s) => (s.id === store.id
          ? { ...s, balance: (Number(s.balance) - amount).toFixed(2), last_payment_at: new Date().toISOString() }
          : s)));
      }
      reportWrite(r, `Abono de ${mxn(amount)} registrado`);
      await loadCobranza();
    },
  });
}

// ================================================================ Merma

async function loadMerma() {
  await load("mermas");
  fillRows("#tbl-merma", cache.mermas, (m) => [
    ["Fecha", shortDate(m.occurred_at)],
    ["Producto", [m.product_name, pendingTag(m)]],
    ["Tienda", m.store_name || "Bodega"],
    ["Motivo", REASON_LABEL[m.reason] || m.reason],
    ["Cant.", m.quantity, "num"],
    ["Pérdida", mxn(m.loss), "num"],
  ], "No hay merma registrada.");
}

async function newMerma() {
  await Promise.all([load("products"), load("stores")]);
  if (!cache.products.length) {
    toast("Primero agrega productos en Inventario.", "warn");
    return;
  }
  return openForm({
    title: "Registrar merma",
    fields: [
      { name: "product_id", label: "Producto", type: "select", required: true,
        options: [{ value: "", label: "Elige el producto" },
          ...cache.products.map((p) => ({ value: p.id, label: p.name }))] },
      { name: "store_id", label: "¿De qué tienda viene?", type: "select",
        options: [{ value: "", label: "De ninguna (bodega o camioneta)" },
          ...cache.stores.map((s) => ({ value: s.id, label: s.name }))],
        hint: "Si viene de una tienda no se descuenta del inventario, porque ya había salido con la venta." },
      { name: "quantity", label: "Cantidad", type: "number", step: "1", min: "1", required: true, value: 1 },
      { name: "reason", label: "Motivo", type: "select", value: "danado", options: REASONS },
      { name: "notes", label: "Notas", type: "textarea" },
    ],
    submitLabel: "Registrar merma",
    onSubmit: async (v) => {
      const product = cache.products.find((p) => String(p.id) === v.product_id);
      const store = cache.stores.find((s) => String(s.id) === v.store_id);
      const quantity = parseInt(v.quantity, 10);
      if (!(quantity > 0)) throw new Error("La cantidad debe ser mayor a cero.");
      const body = {
        product_id: product.id, store_id: store?.id ?? null, quantity,
        reason: v.reason, notes: v.notes.trim() || null, employee_id: currentEmployee(),
      };
      const r = await api.createMerma(body);
      if (r.status === "queued") {
        await patchCache("/api/merma", (list) => [{
          ...body, id: `pendiente-${Date.now()}`, product_name: product.name, store_name: store?.name ?? null,
          loss: (Number(product.cost_price) * quantity).toFixed(2),
          occurred_at: new Date().toISOString(), pending: true,
        }, ...list]);
        if (!store) {
          await patchCache("/api/products", (list) =>
            list.map((p) => (p.id === product.id ? { ...p, stock: p.stock - quantity } : p)));
        }
      }
      reportWrite(r, "Merma registrada");
      await loadMerma();
    },
  });
}

// ================================================================ Equipo

async function loadTeam() {
  await Promise.all([load("employees"), load("vehicles")]);
  fillRows("#tbl-employees", cache.employees, (e) => [
    ["Nombre", [e.name, pendingTag(e)]],
    ["Teléfono", e.phone ? el("a", { href: `tel:${e.phone}` }, e.phone) : "—"],
    ["Vendido", mxn(e.total_sold), "num"],
  ], "Aún no hay repartidores.");
  fillRows("#tbl-vehicles", cache.vehicles, (v) => [
    ["Placas", [v.plate, pendingTag(v)]],
    ["Descripción", v.description || "—"],
  ], "Aún no hay vehículos.");
}

function newEmployee() {
  return openForm({
    title: "Agregar repartidor",
    fields: [
      { name: "name", label: "Nombre", required: true },
      { name: "phone", label: "Teléfono", type: "tel", inputmode: "tel" },
    ],
    submitLabel: "Guardar repartidor",
    onSubmit: async (v) => {
      const body = clean(v);
      const r = await api.createEmployee(body);
      if (r.status === "queued") {
        await patchCache("/api/employees", (list) => [...list, { ...body, id: r.tempId, total_sold: "0.00", pending: true }]);
      }
      reportWrite(r, "Repartidor guardado");
      await loadTeam();
    },
  });
}

function newVehicle() {
  return openForm({
    title: "Agregar vehículo",
    fields: [
      { name: "plate", label: "Placas", required: true },
      { name: "description", label: "Descripción", hint: "Por ejemplo: Nissan NP300 blanca" },
    ],
    submitLabel: "Guardar vehículo",
    onSubmit: async (v) => {
      const body = clean(v);
      body.plate = body.plate.toUpperCase();
      const r = await api.createVehicle(body);
      if (r.status === "queued") {
        await patchCache("/api/vehicles", (list) => [...list, { ...body, id: r.tempId, pending: true }]);
      }
      reportWrite(r, "Vehículo guardado");
      await loadTeam();
    },
  });
}

// ================================================================ Vender

const cart = new Map();   // product_id -> cantidad

async function loadSale() {
  await Promise.all([load("products"), load("stores"), load("employees")]);
  fillSelect("#sale-store", cache.stores, "Elige la tienda", (s) => s.name);
  fillSelect("#sale-employee", cache.employees, "Sin asignar", (e) => e.name, currentEmployee());
  renderCart();
}

function fillSelect(selector, items, placeholder, label, selected) {
  const select = $(selector);
  const keep = selected ?? select.value;
  select.replaceChildren(el("option", { value: "" }, placeholder),
    ...items.map((i) => el("option", { value: i.id, selected: String(i.id) === String(keep) }, label(i))));
}

function priceFor(product) {
  const storeId = $("#sale-store").value;
  return Number(product.store_prices?.[storeId] ?? product.sale_price);
}

function cartItems() {
  return [...cart]
    .map(([id, qty]) => ({ product: cache.products.find((p) => p.id === id), qty }))
    .filter((i) => i.product);
}

const cartTotal = () => cartItems().reduce((sum, i) => sum + priceFor(i.product) * i.qty, 0);

function addToCart(product) {
  cart.set(product.id, (cart.get(product.id) || 0) + 1);
  navigator.vibrate?.(30);
  renderCart();
}

function setQty(id, qty) {
  if (qty <= 0) cart.delete(id);
  else cart.set(id, qty);
  renderCart();
}

function renderCart() {
  const items = cartItems();
  $("#cart").replaceChildren(...(items.length
    ? items.map(({ product: p, qty }) => el("li", { class: "cart-item" },
      el("div", { class: "cart-name" }, p.name, el("small", {}, `${mxn(priceFor(p))} c/u`)),
      el("div", { class: "stepper" },
        el("button", { type: "button", "aria-label": `Quitar uno de ${p.name}`, onclick: () => setQty(p.id, qty - 1) }, "−"),
        el("output", {}, qty),
        el("button", { type: "button", "aria-label": `Agregar uno de ${p.name}`, onclick: () => setQty(p.id, qty + 1) }, "+")),
      el("div", { class: "cart-subtotal" }, mxn(priceFor(p) * qty))))
    : [el("li", { class: "cart-empty" }, "Escanea o busca un producto para agregarlo.")]));
  updateTotals();
}

function updateTotals() {
  const total = cartTotal();
  const paidRaw = $("#sale-paid").value;
  const paid = Number(paidRaw || 0);
  const credit = $("#sale-credit");
  $("#sale-total").textContent = mxn(total);

  let problem = null;
  if (!$("#sale-store").value) problem = "Elige la tienda";
  else if (!cart.size) problem = "Agrega productos";
  else if (paid < 0) problem = "El pago no puede ser negativo";
  else if (paid > total + 0.001) problem = "El pago es mayor al total";

  if (problem && cart.size) credit.textContent = problem;
  else if (total > 0 && paid < total) credit.textContent = `Queda a crédito: ${mxn(total - paid)}`;
  else credit.textContent = "";
  $("#btn-charge").disabled = Boolean(problem);
}

function renderResults() {
  const q = $("#sale-search").value.trim().toLowerCase();
  const box = $("#sale-results");
  if (!q) { box.replaceChildren(); return; }
  const hits = cache.products
    .filter((p) => p.name.toLowerCase().includes(q) || (p.barcode || "").includes(q))
    .slice(0, 6);
  box.replaceChildren(...(hits.length
    ? hits.map((p) => el("li", {}, el("button", {
      type: "button", class: "result",
      onclick: () => { addToCart(p); clearSearch(); },
    }, el("span", {}, p.name), el("span", { class: "result-meta" }, `${mxn(priceFor(p))}, quedan ${p.stock}`))))
    : [el("li", { class: "result-empty" }, "No hay productos con ese nombre o código. ",
      el("button", { type: "button", class: "link", onclick: () => createFromSale(q) }, "Agregarlo al inventario"))]));
}

function clearSearch() {
  $("#sale-search").value = "";
  renderResults();
}

async function createFromSale(text) {
  const isBarcode = /^\d{6,}$/.test(text);
  const saved = await newProduct(isBarcode ? { barcode: text } : { name: text });
  if (!saved) return;
  await load("products");
  const product = isBarcode
    ? cache.products.find((p) => p.barcode === text)
    : [...cache.products].reverse().find((p) => p.name.toLowerCase() === text.toLowerCase());
  if (product) addToCart(product);
  clearSearch();
}

async function scan() {
  const reason = scannerUnavailableReason();
  if (reason) {
    toast(reason, "warn");
    $("#sale-search").focus();
    return;
  }
  try {
    const code = await scanBarcode();
    if (!code) return;
    const product = cache.products.find((p) => p.barcode === code);
    if (product) {
      addToCart(product);
      toast(`${product.name} agregado`);
    } else if (confirm(`Ningún producto tiene el código ${code}. ¿Agregarlo al inventario?`)) {
      await createFromSale(code);
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

async function charge() {
  const button = $("#btn-charge");
  button.disabled = true;
  const storeId = Number($("#sale-store").value);
  const store = cache.stores.find((s) => s.id === storeId);
  const total = cartTotal();
  const paid = Number($("#sale-paid").value || 0);
  const sold = new Map(cart);

  try {
    const r = await api.createSale({
      store_id: storeId,
      employee_id: currentEmployee(),
      items: [...sold].map(([product_id, quantity]) => ({ product_id, quantity })),
      paid_amount: paid.toFixed(2),
    });
    if (r.status === "queued") {
      await patchCache("/api/products", (list) =>
        list.map((p) => (sold.has(p.id) ? { ...p, stock: p.stock - sold.get(p.id) } : p)));
      await patchCache("/api/stores", (list) => list.map((s) => (s.id === storeId
        ? { ...s, balance: (Number(s.balance) + total - paid).toFixed(2) } : s)));
    }
    reportWrite(r, `Venta de ${mxn(total)} a ${store?.name ?? "la tienda"} registrada`);
    cart.clear();
    $("#sale-paid").value = "";
    await loadSale();
  } catch (err) {
    toast(err.message, "error");
    updateTotals();
  }
}

// ================================================================ arranque

export const viewLoaders = {
  vender: loadSale,
  cobranza: loadCobranza,
  inventario: loadInventory,
  tiendas: loadStores,
  merma: loadMerma,
  equipo: loadTeam,
};

export function initViews() {
  $("#btn-new-product").addEventListener("click", () => newProduct());
  $("#product-search").addEventListener("input", renderInventory);
  $("#btn-new-store").addEventListener("click", newStore);
  $("#btn-new-merma").addEventListener("click", newMerma);
  $("#btn-new-employee").addEventListener("click", newEmployee);
  $("#btn-new-vehicle").addEventListener("click", newVehicle);

  $("#btn-scan").addEventListener("click", scan);
  $("#sale-search").addEventListener("input", renderResults);
  $("#sale-search").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const q = e.target.value.trim();
    const exact = cache.products.find((p) => p.barcode && p.barcode === q);
    const first = $("#sale-results .result");
    if (exact) { addToCart(exact); clearSearch(); }
    else first?.click();
  });
  $("#sale-store").addEventListener("change", () => { renderCart(); renderResults(); });
  $("#sale-employee").addEventListener("change", (e) => {
    if (e.target.value) localStorage.setItem(EMPLOYEE_KEY, e.target.value);
    else localStorage.removeItem(EMPLOYEE_KEY);
  });
  $("#sale-paid").addEventListener("input", updateTotals);
  $("#btn-paid-full").addEventListener("click", () => {
    $("#sale-paid").value = cartTotal().toFixed(2);
    updateTotals();
  });
  $("#btn-charge").addEventListener("click", charge);
}
