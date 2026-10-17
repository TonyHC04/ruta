"""Validación de entrada compartida por las rutas. Todas lanzan ValueError
con un mensaje listo para mostrarse al usuario."""
from decimal import Decimal, InvalidOperation

from extensions import db

CENT = Decimal("0.01")


def money(value, field: str) -> Decimal:
    try:
        amount = Decimal(str(value)).quantize(CENT)
    except (InvalidOperation, ValueError, TypeError):
        raise ValueError(f"{field}: escribe un monto válido")
    if amount < 0:
        raise ValueError(f"{field} no puede ser negativo")
    return amount


def to_int(value, field: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field}: escribe un número entero")


def text(value, field: str, max_len: int, required: bool = False):
    value = (str(value).strip() if value is not None else "")
    if required and not value:
        raise ValueError(f"{field} es obligatorio")
    if len(value) > max_len:
        raise ValueError(f"{field}: máximo {max_len} caracteres")
    return value or None


def optional_fk(model, value, label: str):
    """Valida una FK opcional (SQLite no las valida por defecto)."""
    if value in (None, ""):
        return None
    obj = db.session.get(model, to_int(value, label))
    if obj is None:
        raise ValueError(f"{label} {value} no existe")
    return obj.id
