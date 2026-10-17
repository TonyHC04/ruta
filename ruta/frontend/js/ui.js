/** Piezas de interfaz compartidas: creación de nodos, avisos y formularios. */

export const $ = (sel, root = document) => root.querySelector(sel);

export const mxn = (value) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(value) || 0);

/**
 * Crea un elemento. Atributos `on*` con función se vuelven listeners;
 * `true` pone el atributo vacío; `null`/`false` lo omite. Los textos se
 * insertan como texto (nunca como HTML), así un nombre de tienda no rompe nada.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Aviso breve abajo de la pantalla. kind: ok | warn | error */
export function toast(message, kind = "ok") {
  const box = $("#toasts");
  const item = el("div", { class: `toast toast--${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  box.append(item);
  while (box.children.length > 3) box.firstElementChild.remove();   // máximo 3 a la vez
  setTimeout(() => item.remove(), kind === "ok" ? 3500 : 6000);
}

/**
 * Formulario en ventana modal. Si onSubmit lanza un error, el mensaje se
 * muestra dentro del formulario y la ventana sigue abierta.
 *
 * fields: [{ name, label, type?, required?, value?, options?, hint?, step?, min?, inputmode? }]
 *   type: text (default) | number | tel | select | textarea
 *   options (select): [{ value, label }]
 */
export function openForm({ title, fields, submitLabel = "Guardar", onSubmit }) {
  return new Promise((resolve) => {
    const error = el("p", { class: "form-error", role: "alert", hidden: true });
    const submit = el("button", { type: "submit", class: "btn" }, submitLabel);

    const controls = fields.map((f) => {
      const id = `f-${f.name}`;
      let control;
      if (f.type === "select") {
        control = el("select", { id, name: f.name, required: f.required },
          f.options.map((o) => el("option", { value: o.value, selected: String(o.value) === String(f.value ?? "") }, o.label)));
      } else if (f.type === "textarea") {
        control = el("textarea", { id, name: f.name, rows: 3, class: "input" }, f.value ?? "");
      } else {
        control = el("input", {
          id, name: f.name, type: f.type || "text", class: "input", required: f.required,
          value: f.value ?? "", step: f.step, min: f.min, inputmode: f.inputmode,
          autocomplete: "off",
        });
      }
      return el("label", { class: "field", for: id },
        el("span", {}, f.label, f.required ? "" : el("small", { class: "optional" }, " (opcional)")),
        control,
        f.hint && el("small", { class: "hint" }, f.hint));
    });

    const dialog = el("dialog", { class: "modal", "aria-labelledby": "modal-title" });
    const form = el("form", { class: "modal-form" },
      el("h2", { id: "modal-title" }, title),
      ...controls,
      error,
      el("div", { class: "modal-actions" },
        el("button", { type: "button", class: "btn btn--ghost", onclick: () => dialog.close() }, "Cancelar"),
        submit));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(form)));
        resolve(true);
        dialog.close();
      } catch (err) {
        error.textContent = err.message || "No se pudo guardar. Intenta de nuevo.";
        error.hidden = false;
      } finally {
        submit.disabled = false;
      }
    });

    dialog.addEventListener("close", () => { dialog.remove(); resolve(false); });
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    form.querySelector("input, select, textarea")?.focus();
  });
}

/** Mensaje después de guardar: distingue "ya llegó al servidor" de "guardado en el celular". */
export function reportWrite(result, doneMessage) {
  if (result.status === "queued") {
    toast(`${doneMessage} en el celular. Se enviará al volver la señal.`, "warn");
    return;
  }
  toast(doneMessage);
  (result.data?.warnings || []).forEach((w) => toast(w, "warn"));
}

/** Llena el <tbody> de una tabla. cells(row) -> [[etiqueta, valor, clase?], ...] */
export function fillRows(selector, rows, cells, emptyText, onRowClick) {
  const table = $(selector);
  const tbody = $("tbody", table);
  const cols = table.tHead.rows[0].cells.length;
  if (!rows.length) {
    tbody.replaceChildren(el("tr", { class: "empty" }, el("td", { colspan: cols }, emptyText)));
    return;
  }
  tbody.replaceChildren(...rows.map((row) => {
    const tr = el("tr", {}, cells(row).map(([label, value, cls]) =>
      el("td", { "data-label": label, class: cls || null }, value)));
    if (onRowClick) {
      tr.classList.add("row-link");
      tr.tabIndex = 0;
      tr.addEventListener("click", (e) => { if (!e.target.closest("button, a")) onRowClick(row); });
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") onRowClick(row); });
    }
    return tr;
  }));
}

export function shortDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" });
}
