"""Tiendas, con su saldo pendiente (fiado) y el último abono."""
from decimal import Decimal

from flask import Blueprint, jsonify, request
from sqlalchemy import func

from extensions import db
from models import Payment, Sale, Store
from utils.idempotency import idempotent
from utils.timeutils import iso_utc
from utils.validation import text

bp = Blueprint("stores", __name__, url_prefix="/api/stores")


@bp.get("")
def list_stores():
    sold = dict(db.session.query(Sale.store_id, func.sum(Sale.total)).group_by(Sale.store_id).all())
    paid = dict(db.session.query(Payment.store_id, func.sum(Payment.amount)).group_by(Payment.store_id).all())
    last = dict(db.session.query(Payment.store_id, func.max(Payment.occurred_at)).group_by(Payment.store_id).all())

    stores = Store.query.filter_by(is_active=True).order_by(Store.name).all()
    return jsonify([{
        **s.to_dict(),
        "balance": f"{Decimal(str(sold.get(s.id) or 0)) - Decimal(str(paid.get(s.id) or 0)):.2f}",
        "last_payment_at": iso_utc(last.get(s.id)),
    } for s in stores])


def _apply(store: Store, data: dict, creating: bool) -> None:
    if creating or "name" in data:
        store.name = text(data.get("name"), "Nombre", 150, required=True)
    for field, label, size in (("owner_name", "Encargado", 120), ("phone", "Teléfono", 20),
                               ("address", "Dirección", 255)):
        if creating or field in data:
            setattr(store, field, text(data.get(field), label, size))
    if "is_active" in data:
        store.is_active = bool(data["is_active"])


# creacion de tienda/nombre/id
@bp.post("")
@idempotent
def create_store():
    store = Store()
    try:
        _apply(store, request.get_json(silent=True) or {}, creating=True)
    except ValueError as err:
        return {"error": str(err)}, 400
    db.session.add(store)
    db.session.flush()
    return {**store.to_dict(), "balance": "0.00", "last_payment_at": None}, 201


# normalizacion de tienda
@bp.put("/<int:store_id>")
@idempotent
def update_store(store_id: int):
    store = db.session.get(Store, store_id)
    if store is None:
        return {"error": "La tienda no existe"}, 404
    try:
        _apply(store, request.get_json(silent=True) or {}, creating=False)
    except ValueError as err:
        return {"error": str(err)}, 400
    db.session.flush()
    return store.to_dict(), 200
