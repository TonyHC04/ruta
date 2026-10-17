/**
 * Escáner de código de barras con la cámara (Barcode Detection API).
 *
 * Funciona en Chrome para Android. Requisitos del navegador para usar la
 * cámara: HTTPS o localhost. Si no se cumplen, devuelve un motivo claro para
 * que el repartidor escriba el código a mano.
 */
import { el } from "./ui.js";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"];

export function scannerUnavailableReason() {
  if (!window.isSecureContext) return "La cámara solo funciona con https. Escribe el código en el buscador.";
  if (!("BarcodeDetector" in window)) return "Este navegador no puede escanear. Usa Chrome en Android o escribe el código.";
  if (!navigator.mediaDevices?.getUserMedia) return "No se encontró una cámara disponible.";
  return null;
}

/** Abre la cámara y resuelve con el código leído, o null si se cancela. */
export async function scanBarcode() {
  const supported = await BarcodeDetector.getSupportedFormats();
  const detector = new BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch {
    throw new Error("No se dio permiso para usar la cámara.");
  }

  return new Promise((resolve) => {
    const video = el("video", { class: "scanner-video", playsinline: true, muted: true });
    const dialog = el("dialog", { class: "modal modal--scanner", "aria-label": "Escanear código" },
      video,
      el("p", { class: "scanner-help" }, "Apunta al código de barras"),
      el("button", { type: "button", class: "btn btn--ghost", onclick: () => finish(null) }, "Cancelar"));

    let timer = null;
    let done = false;
    function finish(code) {
      if (done) return;
      done = true;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      dialog.close();
      dialog.remove();
      resolve(code);
    }

    dialog.addEventListener("cancel", () => finish(null));
    document.body.append(dialog);
    dialog.showModal();
    video.srcObject = stream;
    video.play();

    timer = setInterval(async () => {
      if (video.readyState < 2) return;
      try {
        const [hit] = await detector.detect(video);
        if (hit?.rawValue) {
          navigator.vibrate?.(80);
          finish(hit.rawValue);
        }
      } catch { /* cuadro ilegible: se intenta con el siguiente */ }
    }, 250);
  });
}
