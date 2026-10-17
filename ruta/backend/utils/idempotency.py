"""Endpoints de escritura seguros de reintentar.

El frontend manda un header `Idempotency-Key` (UUID) generado cuando el
repartidor toca "Registrar venta". Si la red se cae después de que el servidor
guardó la venta pero antes de que llegue la respuesta, el celular reintenta con
la MISMA clave y recibe la respuesta original: no se duplica la venta.

Contrato para la vista decorada:
- Devuelve (dict, status). No llama a jsonify.
- Idealmente no hace commit: el decorador guarda el resultado y la clave en
  la misma transacción (atómico). Si la vista ya hace commit sigue funcionando,
  solo que en dos pasos.
- Si devuelve status >= 400, se hace rollback y no se guarda la clave
  (corregir los datos y reenviar con la misma clave es válido).
"""
import json
from functools import wraps

from flask import jsonify, request
from sqlalchemy.exc import IntegrityError

from extensions import db
from models import IdempotencyRecord

IDEMPOTENCY_HEADER = "Idempotency-Key"


def _replay(record: IdempotencyRecord):
    if record.endpoint != request.path:
        return jsonify(error="Esa Idempotency-Key ya se usó en otro endpoint"), 422
    response = jsonify(json.loads(record.response_body))
    response.headers["Idempotent-Replayed"] = "true"
    return response, record.status_code


def idempotent(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        key = request.headers.get(IDEMPOTENCY_HEADER)
        if key and len(key) > 64:
            return jsonify(error="Idempotency-Key demasiado larga (máx. 64)"), 400

        if key:
            prior = db.session.get(IdempotencyRecord, key)
            if prior:
                return _replay(prior)

        try:
            payload, status = view(*args, **kwargs)
        except Exception:
            db.session.rollback()
            raise

        if status >= 400:
            db.session.rollback()
            return jsonify(payload), status

        if key:
            db.session.add(IdempotencyRecord(
                key=key, endpoint=request.path, status_code=status,
                response_body=json.dumps(payload, default=str)))
        try:
            db.session.commit()
        except IntegrityError:
            # Dos reintentos simultáneos con la misma clave: gana el primero.
            db.session.rollback()
            prior = db.session.get(IdempotencyRecord, key) if key else None
            if prior:
                return _replay(prior)
            raise
        return jsonify(payload), status

    return wrapper
