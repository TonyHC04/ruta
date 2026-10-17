"""Punto de entrada para PythonAnywhere u otro servidor WSGI."""
from dotenv import load_dotenv

load_dotenv()

from app import app as application  # noqa: E402
