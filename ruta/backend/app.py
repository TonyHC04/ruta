"""App factory de Ruta Manifiesto.

Flask sirve el API (/api/...) y el frontend desde el mismo puerto, así el
service worker y las llamadas a /api funcionan sin configurar CORS.
"""
import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, send_from_directory

from extensions import db, migrate

load_dotenv()

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


def create_app() -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config.update(
        SQLALCHEMY_DATABASE_URI=os.getenv("DATABASE_URL", "sqlite:///ruta_manifiesto.db"),
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
        SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True},   # evita "MySQL server has gone away"
        APP_TIMEZONE=os.getenv("APP_TIMEZONE", "America/Mexico_City"),
        SECRET_KEY=os.getenv("SECRET_KEY", "cambia-esto-en-produccion"),
    )

    db.init_app(app)
    migrate.init_app(app, db)

    import models  # noqa: F401  registra los modelos para Flask-Migrate
    from routes.dashboard import bp as dashboard_bp
    from routes.merma import bp as merma_bp
    from routes.products import bp as products_bp
    from routes.sales import bp as sales_bp
    from routes.stores import bp as stores_bp
    from routes.team import employees_bp, vehicles_bp
    for blueprint in (products_bp, stores_bp, employees_bp, vehicles_bp,
                      sales_bp, merma_bp, dashboard_bp):
        app.register_blueprint(blueprint)

    @app.get("/")
    def index():
        return send_from_directory(FRONTEND_DIR, "index.html")

    @app.get("/<path:filename>")
    def frontend(filename):
        response = send_from_directory(FRONTEND_DIR, filename)
        if filename == "service-worker.js":
            response.headers["Cache-Control"] = "no-cache"   # que el navegador detecte versiones nuevas
        return response

    return app


app = create_app()

if __name__ == "__main__":
    with app.app_context():
        db.create_all()   # atajo para desarrollo; en producción usa flask db upgrade
    app.run(debug=True)
