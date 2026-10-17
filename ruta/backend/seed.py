"""Datos de ejemplo para probar el dashboard. Uso: python seed.py

Borra y recrea las tablas: no lo corras sobre una base con datos reales.
"""
import random
from datetime import timedelta
from decimal import Decimal

from app import app
from extensions import db
from models import Employee, Merma, Payment, Product, Sale, SaleItem, Store, Vehicle
from utils.timeutils import utcnow

with app.app_context():
    db.drop_all()
    db.create_all()

    stores = [Store(name=n) for n in ["Abarrotes Lupita", "Miscelánea El Güero",
                                      "Tienda Doña Rosa", "Súper Mary"]]
    employees = [Employee(name="Toño"), Employee(name="Beto")]
    products = [
        Product(name="Papas 45g", barcode="7501000000011", cost_price=Decimal("8"),
                sale_price=Decimal("12"), stock=400),
        Product(name="Cacahuate 100g", barcode="7501000000028", cost_price=Decimal("10"),
                sale_price=Decimal("16"), stock=400),
        Product(name="Chicharrón 60g", barcode="7501000000035", cost_price=Decimal("7"),
                sale_price=Decimal("11"), stock=400),
    ]
    db.session.add_all(stores + employees + products + [Vehicle(plate="ABC-123-D", description="Nissan NP300")])
    db.session.commit()

    random.seed(7)
    now = utcnow()
    for _ in range(60):
        when = now - timedelta(days=random.randint(0, 20), hours=random.randint(0, 9))
        store, product, qty = random.choice(stores), random.choice(products), random.randint(2, 10)
        sale = Sale(store=store, employee=random.choice(employees), occurred_at=when,
                    total=product.sale_price * qty, cost_total=product.cost_price * qty)
        sale.items.append(SaleItem(product=product, quantity=qty,
                                   unit_price=product.sale_price, unit_cost=product.cost_price))
        product.stock -= qty
        db.session.add(sale)
        if random.random() < 0.6:   # el resto queda fiado
            db.session.add(Payment(store=store, sale=sale, amount=sale.total, occurred_at=when))

    db.session.add(Merma(product=products[0], store=stores[0], quantity=3,
                         unit_cost=products[0].cost_price, occurred_at=now))
    db.session.commit()
    print("Listo: 4 tiendas, 2 repartidores, 3 productos y 60 ventas de ejemplo.")
