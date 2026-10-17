"""Productos (inventario)."""
from collections import defaultdict

from flask import Blueprint, jsonify, request

from extensions import db
from models import Product, StoreProductPrice
from utils.idempotency import idempotent
from utils.validation import money, text, to_int

bp = Blueprint("products", __name__, url_prefix="/api/products")


@bp.get("")
def list_products():
    """Productos activos. Incluye `store_prices` {store_id: precio} para que la
    terminal muestre el precio correcto de cada tienda, también sin red."""
    products = Product.query.filter_by(is_active=True).order_by(Product.name).all()
    special = defaultdict(dict)
    for sp in StoreProductPrice.query.all():
        special[sp.product_id][str(sp.store_id)] = str(sp.sale_price)
    return jsonify([{**p.to_dict(), "store_prices": special.get(p.id, {})} for p in products])


def _apply(product: Product, data: dict, creating: bool) -> None:
    if creating or "name" in data:
        product.name = text(data.get("name"), "Nombre", 150, required=True)
    if creating or "barcode" in data:
        barcode = text(data.get("barcode"), "Código de barras", 64)
        if barcode:
            taken = Product.query.filter(Product.barcode == barcode, Product.id != product.id).first()
            if taken:
                raise ValueError(f"El código {barcode} ya es de «{taken.name}»")
        product.barcode = barcode
    if creating or "cost_price" in data:
        product.cost_price = money(data.get("cost_price") or 0, "Costo")
    if creating or "sale_price" in data:
        product.sale_price = money(data.get("sale_price") or 0, "Precio de venta")
    if creating or "stock" in data:
        product.stock = to_int(data.get("stock") or 0, "Stock")
    if "is_active" in data:
        product.is_active = bool(data["is_active"])


@bp.post("")
@idempotent
def create_product():
    product = Product()
    try:
        _apply(product, request.get_json(silent=True) or {}, creating=True)
    except ValueError as err:
        return {"error": str(err)}, 400
    db.session.add(product)
    db.session.flush()
    return product.to_dict(), 201


@bp.put("/<int:product_id>")
@idempotent
def update_product(product_id: int):
    product = db.session.get(Product, product_id)
    if product is None:
        return {"error": "El producto no existe"}, 404
    try:
        _apply(product, request.get_json(silent=True) or {}, creating=False)
    except ValueError as err:
        return {"error": str(err)}, 400
    db.session.flush()
    return product.to_dict(), 200
