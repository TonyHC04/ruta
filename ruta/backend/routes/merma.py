"""Merma y devoluciones.

Regla de inventario:
- Merma SIN tienda (se dañó en bodega o en la camioneta): se descuenta del stock.
- Merma CON tienda (devolución dañada): no se descuenta, porque ese producto
  ya salió del inventario cuando se vendió a la tienda.
"""
from flask import Blueprint, jsonify, request

from extensions import db
from models import Merma, MermaReason, Product, Store
from utils.idempotency import IDEMPOTENCY_HEADER, idempotent
from utils.timeutils import iso_utc, parse_client_datetime
from utils.validation import optional_fk, text, to_int

bp = Blueprint("merma", __name__, url_prefix="/api/merma")


def _to_dict(m: Merma) -> dict:
    return {"id": m.id, "product_id": m.product_id, "product_name": m.product.name,
            "store_id": m.store_id, "store_name": m.store.name if m.store else None,
            "quantity": m.quantity, "unit_cost": str(m.unit_cost),
            "loss": str(m.unit_cost * m.quantity), "reason": m.reason.value,
            "notes": m.notes, "occurred_at": iso_utc(m.occurred_at)}


@bp.get("")
def list_merma():
    rows = Merma.query.order_by(Merma.occurred_at.desc()).limit(200).all()
    return jsonify([_to_dict(m) for m in rows])


@bp.post("")
@idempotent
def create_merma():
    data = request.get_json(silent=True) or {}
    try:
        product = db.session.get(Product, to_int(data.get("product_id"), "Producto"))
        if product is None:
            raise ValueError("El producto no existe")
        quantity = to_int(data.get("quantity"), "Cantidad")
        if quantity <= 0:
            raise ValueError("La cantidad debe ser mayor a cero")
        try:
            reason = MermaReason(data.get("reason") or "danado")
        except ValueError:
            raise ValueError("Motivo inválido")
        merma = Merma(
            client_uuid=request.headers.get(IDEMPOTENCY_HEADER),
            product=product,
            store_id=optional_fk(Store, data.get("store_id"), "Tienda"),
            employee_id=data.get("employee_id") or None,
            quantity=quantity, unit_cost=product.cost_price, reason=reason,
            notes=text(data.get("notes"), "Notas", 255),
            occurred_at=parse_client_datetime(data.get("occurred_at")),
        )
    except ValueError as err:
        return {"error": str(err)}, 400

    if merma.store_id is None:
        product.stock -= quantity
    db.session.add(merma)
    db.session.flush()
    return _to_dict(merma), 201
