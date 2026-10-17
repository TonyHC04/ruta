"""Repartidores y vehículos."""
from flask import Blueprint, jsonify, request
from sqlalchemy import func

from extensions import db
from models import Employee, Sale, Vehicle
from utils.idempotency import idempotent
from utils.validation import text

employees_bp = Blueprint("employees", __name__, url_prefix="/api/employees")
vehicles_bp = Blueprint("vehicles", __name__, url_prefix="/api/vehicles")

# total lista repartiodres, vehiculos
@employees_bp.get("")
def list_employees():
    sold = dict(db.session.query(Sale.employee_id, func.sum(Sale.total))
                .filter(Sale.employee_id.isnot(None)).group_by(Sale.employee_id).all())
    employees = Employee.query.filter_by(is_active=True).order_by(Employee.name).all()
    return jsonify([{**e.to_dict(), "total_sold": f"{sold.get(e.id) or 0:.2f}"} for e in employees])

# Base de datos employee, vehicle
@employees_bp.post("")
@idempotent
def create_employee():
    data = request.get_json(silent=True) or {}
    try:
        employee = Employee(name=text(data.get("name"), "Nombre", 120, required=True),
                            phone=text(data.get("phone"), "Teléfono", 20))
    except ValueError as err:
        return {"error": str(err)}, 400
    db.session.add(employee)
    db.session.flush()
    return {**employee.to_dict(), "total_sold": "0.00"}, 201

#filtro lista de vehiculoS
@vehicles_bp.get("")
def list_vehicles():
    vehicles = Vehicle.query.filter_by(is_active=True).order_by(Vehicle.plate).all()
    return jsonify([v.to_dict() for v in vehicles])

# alerta de exitencia de vehiculo o usuario 
@vehicles_bp.post("")
@idempotent
def create_vehicle():
    data = request.get_json(silent=True) or {}
    try:
        plate = text(data.get("plate"), "Placas", 15, required=True).upper()
        if Vehicle.query.filter_by(plate=plate).first():
            raise ValueError(f"Ya existe un vehículo con placas {plate}")
        vehicle = Vehicle(plate=plate, description=text(data.get("description"), "Descripción", 120))
    except ValueError as err:
        return {"error": str(err)}, 400
    db.session.add(vehicle)
    db.session.flush()
    return vehicle.to_dict(), 201
