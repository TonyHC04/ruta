# Ruta · App de reparto offline-first

> Sistema de ventas y cobranza para una distribuidora de botanas. **En uso real en campo** con repartidores.

Los repartidores registran ventas, abonos y mermas desde el celular **aunque no tengan señal**. Cuando vuelve la conexión, todo se sincroniza solo y sin duplicados.

![captura](docs/captura.png)

## El problema
En ruta no siempre hay internet. Antes se anotaba en papel, lo que causaba errores de cobranza, saldos de tiendas desactualizados y merma sin control.

## Qué hace
- **Terminal de venta móvil** con escaneo de código de barras usando la cámara
- **Cobranza:** saldo pendiente por tienda y registro de abonos
- **Inventario** y **precios por tienda**
- **Merma y devoluciones** con motivo
- **Equipo:** repartidores, vehículos y roles
- **Dashboard** con el resumen del día

## Cómo está hecho
| Capa | Tecnología |
|---|---|
| Backend | Python, Flask, SQLAlchemy, Flask-Migrate |
| Base de datos | SQLite (desarrollo) / MySQL (producción) |
| Frontend | HTML, CSS y JavaScript vanilla (ES modules), PWA instalable |
| Offline | Service Worker (cache-first) + IndexedDB + cola de sincronización |

**Decisiones técnicas importantes:**
- **Idempotencia:** decorador `@idempotent` para que un reintento por mala señal nunca duplique una venta o un abono.
- **Cola offline ordenada** con reintentos y bandeja de registros rechazados.
- **Fechas en UTC** con conversión desde la hora del celular.
- Modelo relacional de 12 tablas: usuarios, empleados, vehículos, productos, tiendas, precios por tienda, ventas, detalle de venta, merma, abonos.

## Estructura

```
ruta-manifiesto/
├── backend/
│   ├── app.py              App factory; sirve API y frontend en el mismo puerto
│   ├── wsgi.py             Entrada para PythonAnywhere
│   ├── extensions.py       SQLAlchemy + Flask-Migrate
│   ├── models.py           Esquema completo (usuarios, catálogos, ventas, merma, abonos)
│   ├── seed.py             Datos de ejemplo (borra la base)
│   ├── routes/
│   │   ├── products.py     Inventario: listar, agregar, editar
│   │   ├── stores.py       Tiendas con saldo pendiente y último abono
│   │   ├── team.py         Repartidores y vehículos
│   │   ├── sales.py        Ventas y abonos
│   │   ├── merma.py        Merma y devoluciones
│   │   └── dashboard.py    GET /api/dashboard/summary
│   ├── utils/
│   │   ├── idempotency.py  Decorador @idempotent (reintentos sin duplicar)
│   │   ├── validation.py   Validación de montos, textos e IDs
│   │   └── timeutils.py    Fechas en UTC y parseo de la hora del celular
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── index.html          Panel administrativo + terminal de venta
    ├── css/style.css       Tokens del Boceto 3 (morado #8e44ad, amarillo #f1c40f)
    ├── js/
    │   ├── shell.js        Navegación, roles, indicador de sincronización
    │   ├── dashboard.js    Vista Resumen
    │   ├── views.js        Vender, Cobranza, Inventario, Tiendas, Merma, Equipo
    │   ├── ui.js           Formularios en ventana, avisos, tablas
    │   ├── scanner.js      Escaneo de código de barras con la cámara
    │   ├── api.js          Lecturas con caché y escrituras con cola
    │   ├── sync.js         Cola offline ordenada, reintentos, rechazados
    │   └── db.js           IndexedDB
    ├── manifest.json
    └── service-worker.js   App shell cache-first
```

## Correrlo localmente
```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env             # Windows: copy .env.example .env
python seed.py                   # opcional: datos de ejemplo
python app.py                    # http://localhost:5000
```
Para probar el modo offline: DevTools → Network → Offline, registra una venta y vuelve a poner Online.

## Base de datos y migraciones

`python app.py` crea las tablas si no existen (atajo de desarrollo). Para
producción usa migraciones:

```bash
flask --app app db init        # solo la primera vez
flask --app app db migrate -m "esquema inicial"
flask --app app db upgrade
```

Para MySQL, define `DATABASE_URL` en `.env` (ver `.env.example`).

## Cómo funciona el offline

- **Lecturas:** red primero; sin red se usa la última copia en IndexedDB y la
  pantalla avisa de qué hora son los datos.
- **Escrituras:** cada una recibe una `Idempotency-Key` al crearse. Si hay red
  y la cola está vacía se envía directo; si no, se encola. La cola se envía en
  orden (una venta antes que su abono).
- **Errores temporales** (sin red, 5xx, 408, 429, 401): la cola se detiene y
  reintenta con espera creciente, hasta 5 minutos.
- **Rechazos** (otros 4xx): la acción pasa a "Rechazados" para corregirla o
  descartarla, y la cola sigue.
- **Reintento con la misma clave:** el servidor devuelve la respuesta original
  en vez de crear otro registro.
- **Registros creados offline** (una tienda nueva) reciben un ID temporal
  negativo; al sincronizar se reemplaza en las acciones que lo usan.
- Las ventas guardan `occurred_at`, la hora real en ruta, así el dashboard las
  cuenta en el día correcto aunque se sincronicen después.

## Dashboard

`GET /api/dashboard/summary?period=day|week|month|year` (o `from`/`to`, y
`employee_id` opcional). Calcula en hora de CDMX:

- ganancia neta = ventas − costo de lo vendido − merma
- cobrado en el periodo y cuentas por cobrar al día de hoy
- tiendas que más compran, ventas por repartidor, productos con stock negativo

## Reglas del negocio

- **Merma sin tienda** (bodega o camioneta) se descuenta del inventario.
  **Merma de una tienda** (devolución dañada) no, porque ya salió con la venta.
- **Venta sin stock suficiente** se acepta (el producto ya se entregó) y el
  resumen avisa qué productos quedaron en negativo para hacer conteo.
- **Abono mayor al saldo** se acepta y se avisa que la tienda queda con saldo a favor.
- **Repartidor** de la terminal se recuerda en ese celular para las siguientes ventas.

## Escáner

Usa la cámara con la Barcode Detection API: funciona en Chrome para Android y
necesita https. Si no está disponible, la app lo dice y se puede escribir el
código en el buscador (Enter agrega el producto). Si el código no existe,
ofrece darlo de alta en ese momento.

## Pendiente

- Login (JWT o sesión) y aplicar roles en el backend. Hoy el rol del menú se
  toma de `<body data-role="admin">`.
- Precios especiales por tienda: el backend y la terminal ya los usan
  (tabla `store_product_prices`), pero falta la pantalla para capturarlos.
- Íconos 192×192 y 512×512 en `frontend/icons/` y agregarlos a `manifest.json`.
- En cada despliegue, sube `VERSION` en `service-worker.js`.

## Autor
**Diego Antonio Hernández Chávez**, estudiante de Ciencia de Datos para Negocios (UNRC)
