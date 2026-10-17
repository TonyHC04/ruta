"""Dashboard y reportería.

GET /api/dashboard/summary
    ?period=day|week|month|year   (default: day)
    &date=YYYY-MM-DD              fecha de referencia (default: hoy, hora local)
    &from=YYYY-MM-DD&to=YYYY-MM-DD  rango personalizado inclusivo (ignora period)
    &employee_id=N                filtra ventas, merma y abonos de un repartidor

Definiciones:
    ventas          suma de Sale.total
    ganancia bruta  ventas - costo de lo vendido (foto de costo en cada partida)
    merma           cantidad * costo unitario de lo perdido
    ganancia neta   ganancia bruta - merma
    cobrado         abonos recibidos en el periodo (incluye pagos de contado)
    por cobrar      saldo vivo de todas las tiendas HOY (no depende del periodo)

Los periodos se calculan en hora local (APP_TIMEZONE, default
America/Mexico_City) y se convierten a UTC para consultar. La semana empieza
en lunes. Los totales y la serie salen de la misma pasada sobre las filas,
así siempre cuadran entre sí.
"""
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from flask import Blueprint, current_app, jsonify, request
from sqlalchemy import func

from extensions import db
from models import Employee, Merma, Payment, Product, Sale, Store

bp = Blueprint("dashboard", __name__, url_prefix="/api/dashboard")

CENT = Decimal("0.01")
MAX_CUSTOM_DAYS = 366


def D(value) -> Decimal:
    return Decimal(str(value)) if value is not None else Decimal("0")


def money(value) -> float:
    """Solo para la respuesta JSON (display). Los cálculos van en Decimal."""
    return float(D(value).quantize(CENT))


# ---------------------------------------------------------------- periodos

def _add_month(d: date) -> date:
    return (d.replace(day=28) + timedelta(days=4)).replace(day=1)


def resolve_range(args, tz) -> tuple[date, date, str, str]:
    """Devuelve (inicio, fin_exclusivo, period, granularidad)."""
    if args.get("from") or args.get("to"):
        start = date.fromisoformat(args["from"])
        end = date.fromisoformat(args["to"]) + timedelta(days=1)
        days = (end - start).days
        if days <= 0 or days > MAX_CUSTOM_DAYS:
            raise ValueError(f"El rango debe tener entre 1 y {MAX_CUSTOM_DAYS} días")
        granularity = "hour" if days == 1 else "day" if days <= 62 else "month"
        return start, end, "custom", granularity

    period = args.get("period", "day")
    ref = date.fromisoformat(args["date"]) if args.get("date") else datetime.now(tz).date()
    if period == "day":
        return ref, ref + timedelta(days=1), period, "hour"
    if period == "week":
        start = ref - timedelta(days=ref.weekday())
        return start, start + timedelta(days=7), period, "day"
    if period == "month":
        start = ref.replace(day=1)
        return start, _add_month(start), period, "day"
    if period == "year":
        start = ref.replace(month=1, day=1)
        return start, start.replace(year=start.year + 1), period, "month"
    raise ValueError("period debe ser day, week, month o year")


def local_midnight_utc(d: date, tz) -> datetime:
    return datetime.combine(d, time.min, tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)


def bucket_keys(start: date, end: date, granularity: str) -> list[str]:
    if granularity == "hour":
        return [f"{h:02d}:00" for h in range(24)]
    keys, d = [], start
    while d < end:
        keys.append(d.isoformat() if granularity == "day" else d.strftime("%Y-%m"))
        d = d + timedelta(days=1) if granularity == "day" else _add_month(d)
    return keys


def bucket_of(utc_naive: datetime, tz, granularity: str) -> str:
    local = utc_naive.replace(tzinfo=timezone.utc).astimezone(tz)
    if granularity == "hour":
        return f"{local.hour:02d}:00"
    return local.date().isoformat() if granularity == "day" else local.strftime("%Y-%m")


# ---------------------------------------------------------------- consultas

def receivables() -> dict:
    """Cuentas por cobrar: vendido - abonado por tienda, solo saldos > 0."""
    sold = (db.session.query(Sale.store_id, func.sum(Sale.total).label("amount"))
            .group_by(Sale.store_id).subquery())
    paid = (db.session.query(Payment.store_id, func.sum(Payment.amount).label("amount"))
            .group_by(Payment.store_id).subquery())
    rows = (db.session.query(Store.id, Store.name, sold.c.amount, paid.c.amount)
            .outerjoin(sold, sold.c.store_id == Store.id)
            .outerjoin(paid, paid.c.store_id == Store.id)
            .all())

    stores = []
    for store_id, name, sold_amt, paid_amt in rows:
        balance = D(sold_amt) - D(paid_amt)
        if balance >= CENT:
            stores.append({"store_id": store_id, "name": name, "balance": balance})
    stores.sort(key=lambda s: s["balance"], reverse=True)
    total = sum((s["balance"] for s in stores), Decimal("0"))
    return {"total": money(total),
            "stores": [{**s, "balance": money(s["balance"])} for s in stores]}


def _empty_bucket():
    return {"sales": Decimal("0"), "cost": Decimal("0"), "merma": Decimal("0")}


@bp.get("/summary")
def summary():
    # TODO(auth): restringir a Role.ADMIN / Role.SUPERVISOR; un repartidor
    # solo debería ver su propio employee_id.
    tz = ZoneInfo(current_app.config.get("APP_TIMEZONE", "America/Mexico_City"))
    try:
        start_d, end_d, period, granularity = resolve_range(request.args, tz)
    except (ValueError, KeyError) as err:
        return jsonify(error=str(err) or "Fechas inválidas: usa YYYY-MM-DD"), 400

    start, end = local_midnight_utc(start_d, tz), local_midnight_utc(end_d, tz)
    employee_id = request.args.get("employee_id", type=int)

    def in_range(model, *extra):
        conds = [model.occurred_at >= start, model.occurred_at < end, *extra]
        if employee_id:
            conds.append(model.employee_id == employee_id)
        return conds

    # --- serie y totales en una sola pasada
    series = {k: _empty_bucket() for k in bucket_keys(start_d, end_d, granularity)}
    sales_count = 0

    for occurred_at, total, cost in db.session.query(
            Sale.occurred_at, Sale.total, Sale.cost_total).filter(*in_range(Sale)):
        b = series.setdefault(bucket_of(occurred_at, tz, granularity), _empty_bucket())
        b["sales"] += D(total)
        b["cost"] += D(cost)
        sales_count += 1

    for occurred_at, qty, unit_cost in db.session.query(
            Merma.occurred_at, Merma.quantity, Merma.unit_cost).filter(*in_range(Merma)):
        series.setdefault(bucket_of(occurred_at, tz, granularity), _empty_bucket())["merma"] += D(unit_cost) * qty

    sales_total = sum((b["sales"] for b in series.values()), Decimal("0"))
    cost_total = sum((b["cost"] for b in series.values()), Decimal("0"))
    merma_total = sum((b["merma"] for b in series.values()), Decimal("0"))
    gross = sales_total - cost_total
    net = gross - merma_total

    collected = db.session.query(func.coalesce(func.sum(Payment.amount), 0)) \
        .filter(*in_range(Payment)).scalar()

    # --- rankings
    top_stores = (db.session.query(Store.id, Store.name,
                                   func.sum(Sale.total), func.sum(Sale.total - Sale.cost_total))
                  .join(Sale, Sale.store_id == Store.id)
                  .filter(*in_range(Sale))
                  .group_by(Store.id, Store.name)
                  .order_by(func.sum(Sale.total).desc())
                  .limit(5).all())

    top_employees = (db.session.query(Employee.id, Employee.name,
                                      func.sum(Sale.total), func.count(Sale.id))
                     .join(Sale, Sale.employee_id == Employee.id)
                     .filter(*in_range(Sale))
                     .group_by(Employee.id, Employee.name)
                     .order_by(func.sum(Sale.total).desc())
                     .limit(5).all())

    negative_stock = Product.query.filter(Product.stock < 0).order_by(Product.stock).limit(20).all()

    return jsonify({
        "period": period,
        "range": {"from": start_d.isoformat(),
                  "to": (end_d - timedelta(days=1)).isoformat(),
                  "timezone": str(tz), "granularity": granularity},
        "totals": {
            "sales": money(sales_total),
            "cost": money(cost_total),
            "gross_profit": money(gross),
            "merma": money(merma_total),
            "net_profit": money(net),
            "collected": money(collected),
            "sales_count": sales_count,
            "margin_pct": round(float(net / sales_total * 100), 1) if sales_total else None,
        },
        "receivables": receivables(),
        "series": [{"label": k,
                    "sales": money(v["sales"]),
                    "net_profit": money(v["sales"] - v["cost"] - v["merma"])}
                   for k, v in series.items()],
        "top_stores": [{"store_id": i, "name": n, "sales": money(s), "profit": money(p)}
                       for i, n, s, p in top_stores],
        "top_employees": [{"employee_id": i, "name": n, "sales": money(s), "sales_count": c}
                          for i, n, s, c in top_employees],
        "negative_stock": [{"id": p.id, "name": p.name, "stock": p.stock} for p in negative_stock],
    })
