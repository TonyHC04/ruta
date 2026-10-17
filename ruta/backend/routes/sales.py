"""Ventas y abonos. Ambos endpoints son seguros de reintentar desde la cola offline."""
from flask import Blueprint, request

from extensions import db
from models import (ZERO, Employee, Payment, Product, Sale, SaleItem, Store,
                    StoreProductPrice, Vehicle, store_balance)
from utils.idempotency import IDEMPOTENCY_HEADER, idempotent
from utils.timeutils import parse_client_datetime
from utils.validation import money as _money, optional_fk as _optional, to_int as _int

bp = Blueprint("sales", __name__, url_prefix="/api/sales")


@bp.post("")
@idempotent
def create_sale():
    try:
        return _create_sale(request.get_json(silent=True) or {})
    except ValueError as err:
        return {"error": str(err)}, 400


def _create_sale(data: dict):
    items = data.get("items") or []
    if not items:
        raise ValueError("La venta no tiene productos")

    store = db.session.get(Store, _int(data.get("store_id"), "store_id"))
    if store is None:
        raise ValueError("La tienda no existe")

    product_ids = {_int(i.get("product_id"), "product_id") for i in items}
    products = {p.id: p for p in
                Product.query.filter(Product.id.in_(product_ids)).with_for_update()}
    special_prices = {sp.product_id: sp.sale_price for sp in StoreProductPrice.query.filter(
        StoreProductPrice.store_id == store.id, StoreProductPrice.product_id.in_(product_ids))}

    sale = Sale(
        client_uuid=request.headers.get(IDEMPOTENCY_HEADER),
        store=store,
        employee_id=_optional(Employee, data.get("employee_id"), "Empleado"),
        vehicle_id=_optional(Vehicle, data.get("vehicle_id"), "Vehículo"),
        occurred_at=parse_client_datetime(data.get("occurred_at")),
        notes=(data.get("notes") or "")[:255] or None,
        total=ZERO, cost_total=ZERO,
    )
    warnings = []

    for raw in items:
        product = products.get(_int(raw.get("product_id"), "product_id"))
        if product is None:
            raise ValueError(f"El producto {raw.get('product_id')} no existe")
        qty = _int(raw.get("quantity"), "quantity")
        if qty <= 0:
            raise ValueError(f"Cantidad inválida para {product.name}")

        # El repartidor puede ajustar el precio en ruta; si no, precio de la tienda o base.
        unit_price = (_money(raw["unit_price"], "unit_price")
                      if raw.get("unit_price") is not None
                      else special_prices.get(product.id, product.sale_price))

        sale.items.append(SaleItem(product=product, quantity=qty,
                                   unit_price=unit_price, unit_cost=product.cost_price))
        sale.total += unit_price * qty
        sale.cost_total += product.cost_price * qty

        product.stock -= qty
        if product.stock < 0:
            warnings.append(f"{product.name} quedó con stock {product.stock}; revisa el inventario")

    paid = _money(data.get("paid_amount") or 0, "paid_amount")
    if paid > sale.total:
        raise ValueError("El pago inicial no puede ser mayor al total")
    if paid > 0:
        db.session.add(Payment(store=store, sale=sale, employee_id=sale.employee_id,
                               amount=paid, method=data.get("payment_method") or "efectivo",
                               occurred_at=sale.occurred_at))

    db.session.add(sale)
    db.session.flush()   # asigna IDs; el commit lo hace @idempotent
    return {**sale.to_dict(), "warnings": warnings}, 201


@bp.post("/payments")
@idempotent
def create_payment():
    """Abono a la cuenta de una tienda (cobranza de fiado)."""
    data = request.get_json(silent=True) or {}
    try:
        store = db.session.get(Store, _int(data.get("store_id"), "store_id"))
        if store is None:
            raise ValueError("La tienda no existe")
        sale_id = _optional(Sale, data.get("sale_id"), "Venta")
        if sale_id and db.session.get(Sale, sale_id).store_id != store.id:
            raise ValueError("Esa venta no pertenece a la tienda")
        amount = _money(data.get("amount"), "amount")
        if amount == 0:
            raise ValueError("El abono debe ser mayor a cero")
    except ValueError as err:
        return {"error": str(err)}, 400

    payment = Payment(
        client_uuid=request.headers.get(IDEMPOTENCY_HEADER),
        store=store, sale_id=sale_id,
        employee_id=data.get("employee_id"),
        amount=amount, method=data.get("method") or "efectivo",
        notes=(data.get("notes") or "")[:255] or None,
        occurred_at=parse_client_datetime(data.get("occurred_at")),
    )
    db.session.add(payment)
    db.session.flush()

    # No se rechaza un sobrepago: el dinero ya se recibió en ruta. Se avisa.
    balance = store_balance(store.id)
    warnings = [f"La tienda queda con saldo a favor de ${-balance:.2f}"] if balance < 0 else []
    return {**payment.to_dict(), "store_balance": str(balance), "warnings": warnings}, 201
