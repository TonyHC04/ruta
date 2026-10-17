/** Vista "Resumen": métricas, gráfica, cuentas por cobrar y rankings. */
import { api } from "./api.js";

const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const dateFmt = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit" });

let period = "day";
let loading = null;

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => (k === "class" ? (node.className = v) : node.setAttribute(k, v)));
  node.append(...children.map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  return node;
}

export function initDashboard() {
  document.querySelectorAll("[data-period]").forEach((btn) => {
    btn.addEventListener("click", () => {
      period = btn.dataset.period;
      document.querySelectorAll("[data-period]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === btn)));
      loadDashboard();
    });
  });
}

export function loadDashboard() {
  if (loading) return loading;
  const root = $("#dashboard");
  root.setAttribute("aria-busy", "true");
  loading = api.dashboard({ period })
    .then(({ data, fromCache, savedAt }) => {
      render(data);
      const stale = $("#dash-stale");
      stale.hidden = !fromCache;
      stale.textContent = fromCache
        ? `Sin conexión. Mostrando datos de las ${timeFmt.format(savedAt)}; se actualizan al volver la red.`
        : "";
      $("#dash-error").hidden = true;
    })
    .catch(() => {
      $("#dash-error").hidden = false;
    })
    .finally(() => {
      root.setAttribute("aria-busy", "false");
      loading = null;
    });
  return loading;
}

function render(d) {
  const t = d.totals;
  setMetric("net_profit", mxn.format(t.net_profit),
    t.margin_pct == null ? "Sin ventas en el periodo" : `Margen ${t.margin_pct}% sobre ventas`);
  setMetric("sales", mxn.format(t.sales), `${t.sales_count} ${t.sales_count === 1 ? "venta" : "ventas"}`);
  setMetric("merma", mxn.format(t.merma), "Valuada a costo");
  setMetric("collected", mxn.format(t.collected), "Contado y abonos");
  setMetric("receivables", mxn.format(d.receivables.total),
    `${d.receivables.stores.length} ${d.receivables.stores.length === 1 ? "tienda debe" : "tiendas deben"}`);

  $("#dash-range").textContent = rangeLabel(d.range);
  $("[data-metric=net_profit]").classList.toggle("metric--loss", t.net_profit < 0);

  renderChart(d.series, d.range.granularity);
  fillTable("#tbl-receivables", d.receivables.stores,
    (s) => [["Tienda", s.name], ["Saldo", mxn.format(s.balance), "num"]],
    "Ninguna tienda tiene saldo pendiente.");
  fillTable("#tbl-top-stores", d.top_stores,
    (s) => [["Tienda", s.name], ["Ventas", mxn.format(s.sales), "num"], ["Ganancia", mxn.format(s.profit), "num"]],
    "Aún no hay ventas en este periodo.");
  fillTable("#tbl-top-employees", d.top_employees,
    (e) => [["Repartidor", e.name], ["Ventas", mxn.format(e.sales), "num"], ["Tickets", e.sales_count, "num"]],
    "Aún no hay ventas en este periodo.");

  $("#stock-alert").hidden = d.negative_stock.length === 0;
  $("#stock-alert-list").replaceChildren(
    ...d.negative_stock.map((p) => el("li", {}, `${p.name}: ${p.stock}`)));
}

function setMetric(name, value, note) {
  const card = $(`[data-metric=${name}]`);
  $(".metric-value", card).textContent = value;
  $(".metric-note", card).textContent = note;
}

function rangeLabel({ from, to, granularity }) {
  const f = new Date(`${from}T12:00:00`);
  const t = new Date(`${to}T12:00:00`);
  if (granularity === "hour") return new Intl.DateTimeFormat("es-MX", { dateStyle: "full" }).format(f);
  if (granularity === "month") return `Año ${f.getFullYear()}`;
  return `${dateFmt.format(f)} al ${dateFmt.format(t)}`;
}

function fillTable(selector, rows, toCells, emptyText) {
  const table = $(selector);
  const tbody = $("tbody", table);
  const cols = table.tHead.rows[0].cells.length;
  if (!rows.length) {
    tbody.replaceChildren(el("tr", { class: "empty" }, el("td", { colspan: cols }, emptyText)));
    return;
  }
  tbody.replaceChildren(...rows.map((row) => el("tr", {},
    ...toCells(row).map(([label, value, cls]) => el("td", { "data-label": label, class: cls ?? "" }, value)))));
}

/** Barras de ganancia neta por bloque de tiempo, en SVG plano. */
function renderChart(series, granularity) {
  const box = $("#chart");
  // Se dibuja al ancho real para que el texto no se encoja en celulares.
  const W = Math.max(box.clientWidth, 280), H = W < 500 ? 180 : 220, padL = 8, padB = 24, padT = 12;
  const values = series.map((s) => s.net_profit);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const y = (v) => padT + ((max - v) / span) * (H - padT - padB);
  const slot = (W - padL * 2) / series.length;
  const barW = Math.max(2, slot * 0.64);
  const every = Math.ceil(series.length / 8);   // no más de ~8 etiquetas

  const ns = "http://www.w3.org/2000/svg";
  const make = (tag, attrs) => {
    const node = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  };

  const svg = make("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Ganancia neta por periodo" });
  svg.append(make("line", { x1: padL, x2: W - padL, y1: y(0), y2: y(0), class: "chart-axis" }));

  series.forEach((s, i) => {
    const x = padL + i * slot + (slot - barW) / 2;
    const rect = make("rect", {
      x, y: Math.min(y(s.net_profit), y(0)), width: barW,
      height: Math.max(Math.abs(y(s.net_profit) - y(0)), s.net_profit ? 1 : 0),
      rx: Math.min(3, barW / 2), class: s.net_profit < 0 ? "chart-bar chart-bar--loss" : "chart-bar",
    });
    const title = make("title", {});
    title.textContent = `${bucketLabel(s.label, granularity)}: ${mxn.format(s.net_profit)} (ventas ${mxn.format(s.sales)})`;
    rect.append(title);
    svg.append(rect);

    if (i % every === 0) {
      const label = make("text", { x: x + barW / 2, y: H - 6, class: "chart-label" });
      label.textContent = bucketLabel(s.label, granularity, true);
      svg.append(label);
    }
  });
  box.replaceChildren(svg);
}

function bucketLabel(key, granularity, short = false) {
  if (granularity === "hour") return short ? key.slice(0, 2) : key;
  if (granularity === "month") {
    return new Intl.DateTimeFormat("es-MX", { month: short ? "short" : "long" }).format(new Date(`${key}-15T12:00:00`));
  }
  const d = new Date(`${key}T12:00:00`);
  return short ? String(d.getDate()) : dateFmt.format(d);
}
