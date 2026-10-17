"""Manejo de fechas.

Regla del proyecto: en la base de datos todo se guarda en UTC "naive"
(sin tzinfo) para que SQLite y MySQL se comporten igual. La hora local
solo aparece en reportes.
"""
from datetime import datetime, timezone


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso_utc(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") + "Z" if dt else None


def parse_client_datetime(value) -> datetime:
    """Convierte la fecha enviada por el celular (ISO 8601) a UTC naive.

    Las ventas hechas offline llegan horas después; usamos la hora en que
    ocurrieron, no la de sincronización. Si el reloj del celular está
    adelantado, se recorta a "ahora" para que nada quede en el futuro.
    """
    if not value:
        return utcnow()
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as err:
        raise ValueError("Fecha inválida: usa formato ISO 8601") from err
    if dt.tzinfo is None:          # sin zona: se asume UTC (así la manda toISOString)
        dt = dt.replace(tzinfo=timezone.utc)
    return min(dt.astimezone(timezone.utc).replace(tzinfo=None), utcnow())
