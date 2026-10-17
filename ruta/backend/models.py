"""Modelos de datos de Ruta Manifiesto.

Convenciones:
- Fechas en UTC naive (ver utils/timeutils.py).
- Dinero en Numeric(12, 2) -> Decimal. Nunca float.
- Ventas y mermas guardan una "foto" de precio y costo al momento del hecho:
  cambiar el precio de un producto no altera ganancias históricas.
- Lo que puede llegar por la cola offline (ventas, mermas, abonos) guarda
  `occurred_at` (cuándo pasó en ruta) y `client_uuid` (su Idempotency-Key).
"""
from decimal import Decimal
from enum import Enum

from sqlalchemy import CheckConstraint, Index, UniqueConstraint, func
from werkzeug.security import check_password_hash, generate_password_hash

from extensions import db
from utils.timeutils import iso_utc, utcnow

Money = db.Numeric(12, 2)
ZERO = Decimal("0.00")


def _enum(enum_cls, length=20):
    """Enum guardado como VARCHAR (portable entre SQLite y MySQL)."""
    return db.Enum(enum_cls, native_enum=False, length=length,
                   values_callable=lambda e: [m.value for m in e])


class TimestampMixin:
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=utcnow, onupdate=utcnow)


# --------------------------------------------------------------------------
# Usuarios y catálogos
# --------------------------------------------------------------------------

class Role(str, Enum):
    ADMIN = "admin"
    SUPERVISOR = "supervisor"
    REPARTIDOR = "repartidor"


class User(TimestampMixin, db.Model):
    """Cuenta de acceso. Un repartidor se liga a su Employee."""
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(50), nullable=False, unique=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(_enum(Role), nullable=False, default=Role.REPARTIDOR)
    employee_id = db.Column(db.Integer, db.ForeignKey("employees.id"), unique=True)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    employee = db.relationship("Employee", back_populates="user")

    def set_password(self, raw: str) -> None:
        self.password_hash = generate_password_hash(raw)

    def check_password(self, raw: str) -> bool:
        return check_password_hash(self.password_hash, raw)


class Employee(TimestampMixin, db.Model):
    __tablename__ = "employees"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False, index=True)
    phone = db.Column(db.String(20))
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    user = db.relationship("User", back_populates="employee", uselist=False)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "phone": self.phone, "is_active": self.is_active}


class Vehicle(TimestampMixin, db.Model):
    __tablename__ = "vehicles"

    id = db.Column(db.Integer, primary_key=True)
    plate = db.Column(db.String(15), nullable=False, unique=True)
    description = db.Column(db.String(120))
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    def to_dict(self):
        return {"id": self.id, "plate": self.plate, "description": self.description,
                "is_active": self.is_active}


class Product(TimestampMixin, db.Model):
    __tablename__ = "products"
    __table_args__ = (
        CheckConstraint("cost_price >= 0", name="ck_products_cost_nonneg"),
        CheckConstraint("sale_price >= 0", name="ck_products_price_nonneg"),
    )

    id = db.Column(db.Integer, primary_key=True)
    # UNIQUE admite varios NULL en SQLite y MySQL: productos sin código conviven.
    barcode = db.Column(db.String(64), unique=True, index=True)
    name = db.Column(db.String(150), nullable=False, index=True)
    cost_price = db.Column(Money, nullable=False, default=ZERO)
    sale_price = db.Column(Money, nullable=False, default=ZERO)   # precio base
    # Puede quedar negativo a propósito: una venta offline no se rechaza por
    # stock (el producto ya se entregó). El dashboard lo reporta para corregir.
    stock = db.Column(db.Integer, nullable=False, default=0)
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    def to_dict(self):
        return {"id": self.id, "barcode": self.barcode, "name": self.name,
                "cost_price": str(self.cost_price), "sale_price": str(self.sale_price),
                "stock": self.stock, "is_active": self.is_active,
                "updated_at": iso_utc(self.updated_at)}


class Store(TimestampMixin, db.Model):
    __tablename__ = "stores"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(150), nullable=False, index=True)
    owner_name = db.Column(db.String(120))
    phone = db.Column(db.String(20))
    address = db.Column(db.String(255))
    is_active = db.Column(db.Boolean, nullable=False, default=True)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "owner_name": self.owner_name,
                "phone": self.phone, "address": self.address, "is_active": self.is_active}


class StoreProductPrice(TimestampMixin, db.Model):
    """Precio especial por tienda. Si no existe, se usa Product.sale_price."""
    __tablename__ = "store_product_prices"
    __table_args__ = (UniqueConstraint("store_id", "product_id", name="uq_store_product"),)

    id = db.Column(db.Integer, primary_key=True)
    store_id = db.Column(db.Integer, db.ForeignKey("stores.id", ondelete="CASCADE"), nullable=False)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id", ondelete="CASCADE"),
                           nullable=False, index=True)
    sale_price = db.Column(Money, nullable=False)     # lo que le cobramos a esa tienda
    resale_price = db.Column(Money)                   # a cuánto lo revende (informativo)


# --------------------------------------------------------------------------
# Transacciones (llegan también por la cola offline)
# --------------------------------------------------------------------------

class Sale(TimestampMixin, db.Model):
    __tablename__ = "sales"
    __table_args__ = (
        Index("ix_sales_occurred_store", "occurred_at", "store_id"),
        Index("ix_sales_occurred_employee", "occurred_at", "employee_id"),
    )

    id = db.Column(db.Integer, primary_key=True)
    client_uuid = db.Column(db.String(64), unique=True)
    store_id = db.Column(db.Integer, db.ForeignKey("stores.id"), nullable=False, index=True)
    employee_id = db.Column(db.Integer, db.ForeignKey("employees.id"))
    vehicle_id = db.Column(db.Integer, db.ForeignKey("vehicles.id"))
    occurred_at = db.Column(db.DateTime, nullable=False, default=utcnow)
    total = db.Column(Money, nullable=False, default=ZERO)
    cost_total = db.Column(Money, nullable=False, default=ZERO)
    notes = db.Column(db.String(255))

    store = db.relationship("Store")
    employee = db.relationship("Employee")
    items = db.relationship("SaleItem", back_populates="sale", cascade="all, delete-orphan")
    payments = db.relationship("Payment", back_populates="sale")

    @property
    def profit(self) -> Decimal:
        return (self.total or ZERO) - (self.cost_total or ZERO)

    @property
    def paid(self) -> Decimal:
        return sum((p.amount for p in self.payments), ZERO)

    def to_dict(self):
        return {"id": self.id, "store_id": self.store_id, "employee_id": self.employee_id,
                "vehicle_id": self.vehicle_id, "occurred_at": iso_utc(self.occurred_at),
                "total": str(self.total), "paid": str(self.paid),
                "pending": str(self.total - self.paid), "notes": self.notes,
                "items": [i.to_dict() for i in self.items]}


class SaleItem(db.Model):
    __tablename__ = "sale_items"
    __table_args__ = (CheckConstraint("quantity > 0", name="ck_sale_items_qty_pos"),)

    id = db.Column(db.Integer, primary_key=True)
    sale_id = db.Column(db.Integer, db.ForeignKey("sales.id", ondelete="CASCADE"),
                        nullable=False, index=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False, index=True)
    quantity = db.Column(db.Integer, nullable=False)
    unit_price = db.Column(Money, nullable=False)   # foto del precio de venta
    unit_cost = db.Column(Money, nullable=False)    # foto del costo

    sale = db.relationship("Sale", back_populates="items")
    product = db.relationship("Product")

    def to_dict(self):
        return {"product_id": self.product_id, "quantity": self.quantity,
                "unit_price": str(self.unit_price),
                "subtotal": str(self.unit_price * self.quantity)}


class MermaReason(str, Enum):
    DANADO = "danado"
    CADUCADO = "caducado"
    DEVOLUCION = "devolucion"
    OTRO = "otro"


class Merma(TimestampMixin, db.Model):
    """Producto perdido. Se valúa a costo; store_id es la tienda de origen."""
    __tablename__ = "mermas"
    __table_args__ = (CheckConstraint("quantity > 0", name="ck_mermas_qty_pos"),)

    id = db.Column(db.Integer, primary_key=True)
    client_uuid = db.Column(db.String(64), unique=True)
    product_id = db.Column(db.Integer, db.ForeignKey("products.id"), nullable=False, index=True)
    store_id = db.Column(db.Integer, db.ForeignKey("stores.id"), index=True)
    employee_id = db.Column(db.Integer, db.ForeignKey("employees.id"))
    quantity = db.Column(db.Integer, nullable=False)
    unit_cost = db.Column(Money, nullable=False)
    reason = db.Column(_enum(MermaReason), nullable=False, default=MermaReason.DANADO)
    notes = db.Column(db.String(255))
    occurred_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)

    product = db.relationship("Product")
    store = db.relationship("Store")


class Payment(TimestampMixin, db.Model):
    """Abono de una tienda. sale_id es opcional: un abono puede ir a cuenta general."""
    __tablename__ = "payments"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_payments_amount_pos"),
        Index("ix_payments_occurred_store", "occurred_at", "store_id"),
    )

    id = db.Column(db.Integer, primary_key=True)
    client_uuid = db.Column(db.String(64), unique=True)
    store_id = db.Column(db.Integer, db.ForeignKey("stores.id"), nullable=False, index=True)
    sale_id = db.Column(db.Integer, db.ForeignKey("sales.id"), index=True)
    employee_id = db.Column(db.Integer, db.ForeignKey("employees.id"))
    amount = db.Column(Money, nullable=False)
    method = db.Column(db.String(20), nullable=False, default="efectivo")
    notes = db.Column(db.String(255))
    occurred_at = db.Column(db.DateTime, nullable=False, default=utcnow)

    store = db.relationship("Store")
    sale = db.relationship("Sale", back_populates="payments")

    def to_dict(self):
        return {"id": self.id, "store_id": self.store_id, "sale_id": self.sale_id,
                "amount": str(self.amount), "method": self.method,
                "occurred_at": iso_utc(self.occurred_at)}


class IdempotencyRecord(db.Model):
    """Respuesta guardada por Idempotency-Key: un reintento recibe la misma
    respuesta en vez de crear un duplicado. Se puede purgar tras ~30 días."""
    __tablename__ = "idempotency_records"

    key = db.Column(db.String(64), primary_key=True)
    endpoint = db.Column(db.String(120), nullable=False)
    status_code = db.Column(db.Integer, nullable=False)
    response_body = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, nullable=False, default=utcnow, index=True)


# --------------------------------------------------------------------------
# Consultas de saldo
# --------------------------------------------------------------------------

def store_balance(store_id: int) -> Decimal:
    """Saldo pendiente (fiado) de una tienda: vendido - abonado."""
    sold = db.session.query(func.coalesce(func.sum(Sale.total), 0)) \
        .filter(Sale.store_id == store_id).scalar()
    paid = db.session.query(func.coalesce(func.sum(Payment.amount), 0)) \
        .filter(Payment.store_id == store_id).scalar()
    return Decimal(str(sold)) - Decimal(str(paid))
