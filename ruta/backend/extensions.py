"""Instancias compartidas de extensiones (se inicializan en la app factory).

En app.py:
    db.init_app(app)
    migrate.init_app(app, db)
"""
from flask_migrate import Migrate
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
migrate = Migrate(render_as_batch=True)  # batch: permite ALTER TABLE en SQLite
