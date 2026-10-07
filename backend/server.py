"""Surgical Store Manager — multi-user POS + inventory + accounting backend.

FastAPI + Supabase PostgreSQL. JWT email/password auth with roles:
  - admin   : everything, including managing users
  - partner : sell, stock, purchases, parties, expenses, reports
  - cashier : sell + reprint receipts only
"""

import os
import re
import hashlib
import hmac
import ipaddress
import logging
import secrets
import uuid
import smtplib
from email.message import EmailMessage
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from enum import Enum
from html import escape
from html.parser import HTMLParser
from pathlib import Path
from typing import Annotated, List, Optional
from urllib.parse import urlparse

import jwt
from bson import ObjectId, Binary
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, APIRouter, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response, JSONResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jwt.exceptions import InvalidTokenError
from supabase_store import SupabaseDocumentDB
from pwdlib import PasswordHash
from pydantic import BaseModel, EmailStr, Field
from starlette.middleware.cors import CORSMiddleware

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("surgical-store")

SUPABASE_DB_URL = os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL")
if not SUPABASE_DB_URL:
    raise RuntimeError("SUPABASE_DB_URL (or DATABASE_URL) is required for the Supabase PostgreSQL backend")
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGORITHM = "HS256"
JWT_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", "43200"))  # 30 days
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@store.com").lower()
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "Admin786")
PARTNER_EMAIL = os.environ.get("PARTNER_EMAIL", "partner@store.com").lower()
PARTNER_PASSWORD = os.environ.get("PARTNER_PASSWORD", "partner123")
CASHIER_EMAIL = os.environ.get("CASHIER_EMAIL", "cashier@store.com").lower()
CASHIER_PASSWORD = os.environ.get("CASHIER_PASSWORD", "cashier123")

# Name shown in password-reset emails.
EMAIL_FROM_NAME = os.environ.get("EMAIL_FROM_NAME", "Surgical Store")

# Password-reset config
RESET_PEPPER = os.environ.get("RESET_TOKEN_PEPPER", JWT_SECRET)
RESET_TTL_MINUTES = 15

# Optional self-hosted SMTP for password-reset emails. The core store does not
# depend on any external provider; leave SMTP_* unset if password-reset email is
# not needed on the server.
SMTP_HOST = os.environ.get("SMTP_HOST", "").strip()
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "").strip()
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER).strip()

password_hash = PasswordHash.recommended()
DUMMY_HASH = password_hash.hash("dummy-not-used")
oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

db = SupabaseDocumentDB(SUPABASE_DB_URL)



# ---------------------------------------------------------------------------
# Email helpers — used for password reset codes
# ---------------------------------------------------------------------------
_SHORTENERS = ("bit.ly", "tinyurl.com", "t.co", "is.gd", "cutt.ly", "goo.gl", "rebrand.ly")
_CRED_ASK = ("reply with your password", "reply with the code", "send your password", "cvv",
             "send us your password", "enter your password below", "confirm your card number",
             "your full card number", "seed phrase", "recovery phrase", "verify your card",
             "social security number", "confirm your bank details")
_HOSTISH = re.compile(r"\b(?:https?://)?((?:[a-z0-9-]+\.)+[a-z]{2,})", re.I)


def _host_ok(host: str) -> bool:
    if not host or "xn--" in host:
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass
    return not any(host == s or host.endswith("." + s) for s in _SHORTENERS)


def _same_site(shown: str, real: str) -> bool:
    return shown == real or real.endswith("." + shown) or shown.endswith("." + real)


class _EmailScan(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags, self.urls, self.anchors = set(), [], []
        self._href, self._text = None, []

    def handle_starttag(self, tag, attrs):
        self.tags.add(tag.lower())
        self.urls += [v for k, v in attrs if k.lower() in ("href", "src") and v]
        if tag.lower() == "a":
            self._href = dict((k.lower(), v) for k, v in attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "a" and self._href is not None:
            self.anchors.append((self._href, "".join(self._text)))
            self._href, self._text = None, []


def _assert_safe_email(subject: str, html: str) -> None:
    scan = _EmailScan()
    scan.feed(html)
    if scan.tags & {"form", "input", "textarea", "select"}:
        raise ValueError("No forms or input fields in email (G2)")
    body = f"{subject}\n{html}".lower()
    for p in _CRED_ASK:
        if p in body:
            raise ValueError(f"Email asks the recipient for credentials: {p!r} (G2)")
    for url in scan.urls:
        low = url.strip().lower()
        if low.startswith(("mailto:", "tel:", "cid:", "#")):
            continue
        if not low.startswith("https://"):
            raise ValueError(f"Email links/assets must be absolute https: {url!r} (G3)")
        host = urlparse(low).hostname or ""
        if not _host_ok(host) or urlparse(low).username is not None:
            raise ValueError(f"Shortened, numeric-host or credential-bearing URL: {url!r} (G3)")
    for href, text in scan.anchors:
        real = urlparse(href.strip().lower()).hostname or ""
        if not real:
            continue
        for m in _HOSTISH.finditer(text):
            if not _same_site(m.group(1).lower(), real):
                raise ValueError(f"Anchor text {m.group(1)!r} != real link host {real!r} (G3)")


async def send_email(*, to: str, subject: str, html: str) -> Optional[str]:
    _assert_safe_email(subject, html)
    if not SMTP_HOST or not SMTP_FROM:
        logger.warning("SMTP is not configured; skipping password-reset email")
        return None

    def _send() -> None:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = SMTP_FROM
        msg["To"] = to
        msg.set_content("Your email client does not support HTML email. Please use the reset code shown in the message.")
        msg.add_alternative(html, subtype="html")
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            if SMTP_USER:
                smtp.login(SMTP_USER, SMTP_PASSWORD)
            smtp.send_message(msg)

    await run_in_threadpool(_send)
    return None

def _reset_code_hash(code: str) -> str:
    return hmac.new(RESET_PEPPER.encode(), code.encode(), hashlib.sha256).hexdigest()


# ---------------------------------------------------------------------------
# Roles & enums
# ---------------------------------------------------------------------------
class Role(str, Enum):
    admin = "admin"
    partner = "partner"
    cashier = "cashier"


class PartyType(str, Enum):
    supplier = "supplier"
    customer = "customer"


class ExpenseBucket(str, Enum):
    cogs = "cogs"            # cash expense -> Remaining Balance only
    operating = "operating"  # cash expense -> Remaining Balance only
    personal = "personal"    # personal expense -> Net Profit only


class PaymentKind(str, Enum):
    pay = "pay"          # money paid to a supplier (settles what we owe)
    receive = "receive"  # money received from a customer (settles what they owe)
    supplier_refund = "supplier_refund"  # cash a supplier gave back to us
    customer_refund = "customer_refund"  # cash we handed back to a customer


def oid(v) -> str:
    return str(v)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ----- Auth models -----
class UserCreate(BaseModel):
    email: EmailStr
    name: str
    password: str = Field(min_length=4)
    role: Role


class UserUpdate(BaseModel):
    email: Optional[EmailStr] = None
    name: Optional[str] = None
    role: Optional[Role] = None
    password: Optional[str] = Field(default=None, min_length=4)
    disabled: Optional[bool] = None


class UserOut(BaseModel):
    id: str
    email: EmailStr
    name: str
    role: Role
    disabled: bool = False
    pending: bool = False
    created_at: Optional[str] = None


class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserOut


class SignupIn(BaseModel):
    email: EmailStr
    name: str
    password: str = Field(min_length=4)


class ForgotIn(BaseModel):
    email: EmailStr


class ResetIn(BaseModel):
    email: EmailStr
    code: str = Field(min_length=4, max_length=10)
    new_password: str = Field(min_length=4)


class SettingsIn(BaseModel):
    store_name: str = Field(min_length=1, max_length=60)


# ----- Product models -----
class ProductIn(BaseModel):
    name: str
    barcode: str = ""
    purchase_price: float = 0
    sale_price: float = 0
    low_stock_threshold: float = 5
    expiry_date: Optional[str] = None


class ProductOut(ProductIn):
    id: str
    cost_layers: List[dict] = Field(default_factory=list)
    quantity: float = 0
    created_at: str
    updated_at: str


# ----- Party models -----
class PartyIn(BaseModel):
    name: str
    type: PartyType
    phone: str = ""
    address: str = ""


class PartyOut(PartyIn):
    id: str
    created_at: str
    balance: float = 0.0  # supplier: amount we owe; customer: amount they owe us


# ----- Payment / ledger models -----
class PaymentIn(BaseModel):
    party_id: str
    kind: PaymentKind
    amount: float = Field(ge=0)
    adjustment: float = Field(default=0.0, ge=0)  # discount/extra settled without cash (reduces balance)
    note: str = ""


# ----- Budget model -----
class BudgetIn(BaseModel):
    monthly_amount: float = 0.0
    opening_amount: Optional[float] = None


# ----- Sale models -----
class SaleItemIn(BaseModel):
    product_id: str
    quantity: float
    unit_price: float  # editable sale price at cart time


class SaleIn(BaseModel):
    items: List[SaleItemIn]
    customer_id: Optional[str] = None
    discount: float = 0
    note: str = ""
    credit: bool = False  # if true (with a customer), adds to customer's owed balance
    allow_negative_stock: bool = False  # explicit override: permit selling below zero stock


# ----- Purchase models -----
class PurchaseItemIn(BaseModel):
    product_id: str
    quantity: float
    unit_cost: float  # editable purchase price


class PurchaseIn(BaseModel):
    items: List[PurchaseItemIn]
    supplier_id: Optional[str] = None
    note: str = ""


class InventoryAdjustmentIn(BaseModel):
    product_id: str
    delta: float
    reason: str = ""


class StockTransferIn(BaseModel):
    from_product_id: str
    to_product_id: str
    quantity: float = Field(gt=0)
    reason: str = ""



async def _ensure_cost_layers(product: dict) -> list:
    """Reconcile historical cost lots to the authoritative stock quantity."""
    qty = float(product.get("quantity", 0) or 0)
    if qty <= 0:
        return []
    layers = [
        {**x, "quantity": float(x.get("quantity", 0) or 0)}
        for x in (product.get("cost_layers") or [])
        if float(x.get("quantity", 0) or 0) > 1e-9
    ]
    total = sum(float(x.get("quantity", 0) or 0) for x in layers)
    if abs(total - qty) <= 1e-9:
        return layers
    if total < qty:
        return _append_cost_layer(layers, qty - total, float(product.get("purchase_price", 0) or 0), None)
    result = []
    remaining = qty
    for layer in layers:
        if remaining <= 1e-9:
            break
        take = min(float(layer.get("quantity", 0) or 0), remaining)
        if take > 1e-9:
            result.append({**layer, "quantity": take})
            remaining -= take
    return result


def _consume_cost_layers(layers: list, quantity: float) -> tuple[list, float]:
    remaining = float(quantity)
    total_cost = 0.0
    next_layers = []
    for index, layer in enumerate(layers):
        q = float(layer.get("quantity", 0) or 0)
        if q <= 0:
            continue
        take = min(q, remaining)
        total_cost += take * float(layer.get("unit_cost", 0) or 0)
        left = q - take
        if left > 1e-9:
            next_layers.append({**layer, "quantity": left})
        remaining -= take
        if remaining <= 1e-9:
            next_layers.extend(layers[index + 1:])
            break
    if remaining > 1e-9:
        raise HTTPException(status_code=400, detail="Inventory cost layers are inconsistent with stock. Please refresh/sync inventory before selling.")
    return next_layers, total_cost


def _append_cost_layer(layers: list, quantity: float, unit_cost: float, purchase_id: Optional[str] = None) -> list:
    if quantity <= 0:
        return layers
    return [*layers, {"quantity": float(quantity), "unit_cost": float(unit_cost), "purchase_id": purchase_id}]


async def _save_cost_layers(product_id: str, layers: list):
    clean = [
        {"quantity": round(float(x.get("quantity", 0)), 8), "unit_cost": round(float(x.get("unit_cost", 0)), 8), "purchase_id": x.get("purchase_id")}
        for x in layers if float(x.get("quantity", 0) or 0) > 1e-9
    ]
    await db.products.update_one(
        {"_id": ObjectId(product_id)},
        {"$set": {"cost_layers": clean, "updated_at": now_iso()}},
    )


async def _consume_cost_layers_matching(layers: list, quantity: float, unit_cost: float) -> tuple[list, float]:
    """Consume stock at a requested historical cost when possible, then FIFO."""
    remaining = float(quantity)
    total = 0.0
    used = [False] * len(layers)
    for idx, layer in enumerate(layers):
        if abs(float(layer.get("unit_cost", 0) or 0) - float(unit_cost)) > 1e-6:
            continue
        q = float(layer.get("quantity", 0) or 0)
        if q <= 0: continue
        take = min(q, remaining)
        left = q - take
        total += take * float(layer.get("unit_cost", 0) or 0)
        if left > 1e-9: layers[idx] = {**layer, "quantity": left}
        else: used[idx] = True
        remaining -= take
        if remaining <= 1e-9: break
    if remaining > 1e-9:
        for idx, layer in enumerate(layers):
            if used[idx]: continue
            q = float(layer.get("quantity", 0) or 0)
            if q <= 0: continue
            take = min(q, remaining)
            left = q - take
            total += take * float(layer.get("unit_cost", 0) or 0)
            if left > 1e-9: layers[idx] = {**layer, "quantity": left}
            else: used[idx] = True
            remaining -= take
            if remaining <= 1e-9: break
    if remaining > 1e-9:
        raise HTTPException(status_code=400, detail="Inventory cost layers are inconsistent with stock.")
    return [x for i, x in enumerate(layers) if not used[i] and float(x.get("quantity", 0) or 0) > 1e-9], total


async def _migrate_legacy_cost_layers() -> dict:
    """Reconstruct cost lots for existing products from historical transactions."""
    products = await db.products.find({"deleted": {"$ne": True}}).to_list(10000)
    purchases = await db.purchases.find({"deleted": {"$ne": True}}).sort("created_at", 1).to_list(50000)
    sales = await db.sales.find({"deleted": {"$ne": True}}).sort("created_at", 1).to_list(50000)
    returns = await db.returns.find({"deleted": {"$ne": True}}).sort("created_at", 1).to_list(50000)
    purchase_returns = await db.purchase_returns.find({"deleted": {"$ne": True}}).sort("created_at", 1).to_list(50000)
    purchases_by_product = {}
    events = {}
    for po in purchases:
        for it in po.get("items", []) or []:
            pid = str(it.get("product_id"))
            purchases_by_product.setdefault(pid, []).append((po.get("created_at", ""), float(it.get("quantity", 0) or 0), float(it.get("unit_cost", 0) or 0), oid(po["_id"])))
    for sale in sales:
        for it in sale.get("items", []) or []:
            events.setdefault(str(it.get("product_id")), []).append((sale.get("created_at", ""), "sale", float(it.get("quantity", 0) or 0), float(it.get("purchase_price", 0) or 0)))
    for ret in returns:
        for it in ret.get("items", []) or []:
            events.setdefault(str(it.get("product_id")), []).append((ret.get("created_at", ""), "sale_return", float(it.get("quantity", 0) or 0), float(it.get("purchase_price", 0) or 0)))
    for ret in purchase_returns:
        for it in ret.get("items", []) or []:
            events.setdefault(str(it.get("product_id")), []).append((ret.get("created_at", ""), "purchase_return", float(it.get("quantity", 0) or 0), float(it.get("unit_cost", 0) or 0)))
    migrated = 0
    reconciled = 0
    for product in products:
        pid = str(product["_id"])
        existing_layers = product.get("cost_layers") or []
        target_qty = float(product.get("quantity", 0) or 0)
        existing_qty = sum(float(x.get("quantity", 0) or 0) for x in existing_layers)
        # Rebuild only when layers are missing or no longer reconcile to stock.
        if existing_layers and abs(existing_qty - target_qty) <= 1e-9:
            continue
        layers = [{"quantity": q, "unit_cost": cost, "purchase_id": purchase_id}
                  for _, q, cost, purchase_id in purchases_by_product.get(pid, []) if q > 0]
        for _, kind, qty, unit_cost in sorted(events.get(pid, []), key=lambda x: x[0]):
            if qty <= 0: continue
            if kind == "sale_return":
                layers = _append_cost_layer(layers, qty, unit_cost, None)
            else:
                available_layers = sum(float(x.get("quantity", 0) or 0) for x in layers)
                consume_qty = min(qty, max(0.0, available_layers))
                if consume_qty > 1e-9:
                    layers, _ = _consume_cost_layers_matching(layers, consume_qty, unit_cost)
        target = float(product.get("quantity", 0) or 0)
        current = sum(float(x.get("quantity", 0) or 0) for x in layers)
        diff = target - current
        if diff > 1e-9:
            layers = _append_cost_layer(layers, diff, float(product.get("purchase_price", 0) or 0), None)
            reconciled += 1
        elif diff < -1e-9:
            layers, _ = _consume_cost_layers(layers, -diff)
            reconciled += 1
        await _save_cost_layers(pid, layers)
        migrated += 1
    return {"migrated": migrated, "reconciled": reconciled}
\ndef _aggregate_item_quantities(items) -> dict:
    totals = {}
    for item in items:
        if item.quantity > 0:
            totals[item.product_id] = totals.get(item.product_id, 0) + float(item.quantity)
    return totals

# ----- Expense models -----
class ExpenseIn(BaseModel):
    title: str
    category: str = "Other"
    bucket: ExpenseBucket = ExpenseBucket.operating
    amount: float
    note: str = ""


# ----- Return / refund models -----
class ReturnItemIn(BaseModel):
    product_id: str
    quantity: float


class ReturnIn(BaseModel):
    sale_id: str
    items: List[ReturnItemIn]
    reason: str = ""


class PurchaseReturnIn(BaseModel):
    purchase_id: str
    items: List[ReturnItemIn]
    reason: str = ""


# ---------------------------------------------------------------------------
# Lifespan: indexes + seed users
# ---------------------------------------------------------------------------
async def seed_user(email: str, name: str, pwd: str, role: Role):
    await db.users.update_one(
        {"email": email},
        {"$setOnInsert": {
            "email": email,
            "name": name,
            "password_hash": password_hash.hash(pwd),
            "role": role.value,
            "disabled": False,
            "pending": False,
            "created_at": now_iso(),
        }},
        upsert=True,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # The store is offline-first on the device. The server is optional and only
    # used for live sync when a Supabase URL is configured. If the database is
    # unreachable (e.g. no SUPABASE_DB_URL yet), keep the API process up so the
    # app can be pointed at it later — endpoints will surface a clear error
    # instead of the whole server crash-looping.
    try:
        await db.connect()
        await db.users.create_index("email", unique=True)
        await db.password_resets.create_index("expires_at", expireAfterSeconds=0)
        await seed_user(ADMIN_EMAIL, "Administrator", ADMIN_PASSWORD, Role.admin)
        await seed_user(PARTNER_EMAIL, "Store Partner", PARTNER_PASSWORD, Role.partner)
        await seed_user(CASHIER_EMAIL, "Front Cashier", CASHIER_PASSWORD, Role.cashier)
        migration = await _migrate_legacy_cost_layers()
        logger.info("Startup complete; users seeded; cost-layer migration: %s", migration)
    except Exception as e:  # noqa: BLE001
        logger.error(f"Database unavailable at startup ({e}); running without a live DB.")
    yield
    try:
        await db.close()
    except Exception:  # noqa: BLE001
        pass


app = FastAPI(title="Surgical Store Manager API", lifespan=lifespan)
api = APIRouter(prefix="/api")

@app.middleware("http")
async def stale_edit_guard(request: Request, call_next):
    # Client sends the last-known updated_at for records being edited/deleted.
    # Reject a stale write so one device cannot silently overwrite another.
    if request.method in ("PUT", "DELETE"):
        match = re.match(r"^/api/(products|sales|purchases)/([0-9a-fA-F]{24})$", request.url.path)
        expected = request.headers.get("x-expected-updated-at")
        if match and expected:
            collection_name, record_id = match.groups()
            collection = db[collection_name]
            try:
                current = await collection.find_one({"_id": ObjectId(record_id), "deleted": {"$ne": True}})
            except Exception:
                current = None
            if current and str(current.get("updated_at", "")) != expected:
                return JSONResponse(
                    status_code=409,
                    content={"detail": "This record changed on another device. Refresh before saving your changes."},
                )

    response = await call_next(request)

    # Persist a lightweight server audit event for business mutations. No request
    # body is stored here, so passwords/tokens or sale details cannot leak into
    # the audit collection. Audit failures never break the business request.
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and not request.url.path.startswith("/api/auth/"):
        try:
            actor = "unknown"
            actor_id = None
            auth = request.headers.get("authorization", "")
            if auth.lower().startswith("bearer "):
                try:
                    payload = jwt.decode(auth.split(" ", 1)[1], JWT_SECRET, algorithms=[JWT_ALGORITHM])
                    uid = payload.get("sub")
                    if uid and ObjectId.is_valid(uid):
                        actor_doc = await db.users.find_one({"_id": ObjectId(uid)})
                        if actor_doc:
                            actor = actor_doc.get("name") or actor_doc.get("email") or "unknown"
                            actor_id = str(actor_doc.get("_id"))
                except Exception:
                    pass
            await db["audit"].insert_one({
                "action": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "user_id": actor_id,
                "user_name": actor,
                "created_at": now_iso(),
                "deleted": False,
            })
        except Exception:
            pass

    return response



# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def user_public(doc: dict) -> UserOut:
    return UserOut(
        id=oid(doc["_id"]),
        email=doc["email"],
        name=doc.get("name", ""),
        role=doc["role"],
        disabled=doc.get("disabled", False),
        pending=doc.get("pending", False),
        created_at=doc.get("created_at"),
    )


def make_token(doc: dict) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": oid(doc["_id"]), "iat": now, "exp": now + timedelta(minutes=JWT_MINUTES)},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


async def current_user(token: str = Depends(oauth2)) -> dict:
    unauthorized = HTTPException(status_code=401, detail="Invalid or expired session",
                                 headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        uid = payload.get("sub")
        if not uid or not ObjectId.is_valid(uid):
            raise unauthorized
    except (InvalidTokenError, TypeError):
        raise unauthorized
    doc = await db.users.find_one({"_id": ObjectId(uid)})
    if not doc or doc.get("disabled", False):
        raise unauthorized
    return doc


def require_role(*roles: Role):
    async def check(user: dict = Depends(current_user)) -> dict:
        if user["role"] not in [r.value for r in roles]:
            raise HTTPException(status_code=403, detail="You do not have permission for this action")
        return user
    return check


CurrentUser = Annotated[dict, Depends(current_user)]
Staff = Annotated[dict, Depends(require_role(Role.admin, Role.partner))]
AdminOnly = Annotated[dict, Depends(require_role(Role.admin))]
AnyUser = Annotated[dict, Depends(require_role(Role.admin, Role.partner, Role.cashier))]

# ---------------------------------------------------------------------------
# Offline-tools cloud sync: cash shifts + document attachments
# ---------------------------------------------------------------------------
class CashShiftIn(BaseModel):
    opened_at: str
    opened_by: str = ""
    opening_cash: float = Field(ge=0)
    closed_at: Optional[str] = None
    closing_cash: Optional[float] = Field(default=None, ge=0)


class AttachmentIn(BaseModel):
    client_id: str = Field(min_length=8, max_length=100)
    name: str = "Store photo"
    data_url: str = Field(min_length=20)
    created_at: Optional[str] = None
    user: str = ""


@api.get("/cash-shifts/current")
async def get_current_cash_shift(user: AnyUser):
    row = await db["cash_shifts"].find_one(
        {"user_id": oid(user["_id"]), "closed_at": None, "deleted": {"$ne": True}},
        sort=[("opened_at", -1)],
    )
    if not row:
        return None
    return {**row, "id": oid(row["_id"])}


@api.post("/cash-shifts")
async def save_cash_shift(payload: CashShiftIn, user: AnyUser):
    now = now_iso()
    doc = payload.model_dump()
    doc.update({"user_id": oid(user["_id"]), "user_name": user.get("name", ""), "updated_at": now})
    if payload.closed_at:
        await db["cash_shifts"].update_many(
            {"user_id": oid(user["_id"]), "closed_at": None, "deleted": {"$ne": True}},
            {"$set": {"closed_at": payload.closed_at, "closing_cash": payload.closing_cash, "updated_at": now}},
        )
    existing = await db["cash_shifts"].find_one(
        {"user_id": oid(user["_id"]), "opened_at": payload.opened_at, "deleted": {"$ne": True}}
    )
    if existing:
        await db["cash_shifts"].update_one({"_id": existing["_id"]}, {"$set": doc})
        return {**doc, "id": oid(existing["_id"])}
    result = await db["cash_shifts"].insert_one(doc)
    return {**doc, "id": oid(result.inserted_id)}


@api.get("/attachments")
async def list_attachments(user: AnyUser, limit: int = Query(100, ge=1, le=500)):
    rows = await db["attachments"].find(
        {"user_id": oid(user["_id"]), "deleted": {"$ne": True}}
    ).sort("created_at", -1).to_list(limit)
    return [{**row, "id": oid(row["_id"])} for row in rows]


@api.post("/attachments")
async def save_attachment(payload: AttachmentIn, user: AnyUser):
    if len(payload.data_url) > 7_000_000:
        raise HTTPException(status_code=413, detail="Attachment is too large. Maximum 5 MB image data is allowed.")
    if not payload.data_url.startswith("data:image/"):
        raise HTTPException(status_code=400, detail="Only image attachments are supported.")
    doc = payload.model_dump()
    doc.update({
        "user_id": oid(user["_id"]),
        "user": user.get("name", ""),
        "created_at": payload.created_at or now_iso(),
        "updated_at": now_iso(),
    })
    existing = await db["attachments"].find_one({
        "user_id": oid(user["_id"]),
        "client_id": payload.client_id,
        "deleted": {"$ne": True},
    })
    if existing:
        await db["attachments"].update_one({"_id": existing["_id"]}, {"$set": doc})
        return {**doc, "id": oid(existing["_id"])}
    result = await db["attachments"].insert_one(doc)
    return {**doc, "id": oid(result.inserted_id)}



# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------
@api.get("/audit")
async def list_audit(_: AdminOnly, limit: int = Query(500, ge=1, le=1000)):
    rows = await db["audit"].find({"deleted": {"$ne": True}}).sort("created_at", -1).to_list(limit)
    return [
        {
            "id": oid(row["_id"]),
            "action": row.get("action", ""),
            "method": row.get("action", ""),
            "path": row.get("path", ""),
            "status": row.get("status"),
            "user_name": row.get("user_name", "unknown"),
            "created_at": row.get("created_at", ""),
        }
        for row in rows
    ]

async def next_seq(name: str) -> int:
    doc = await db.counters.find_one_and_update(
        {"_id": name}, {"$inc": {"seq": 1}}, upsert=True, return_document=True,
    )
    return doc["seq"]


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
@api.post("/auth/login", response_model=Token)
async def login(form: OAuth2PasswordRequestForm = Depends()):
    email = form.username.lower().strip()
    doc = await db.users.find_one({"email": email})
    valid = password_hash.verify(form.password, doc["password_hash"]) if doc else password_hash.verify(form.password, DUMMY_HASH)
    if not doc or not valid or doc.get("disabled", False):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    return Token(access_token=make_token(doc), token_type="bearer", user=user_public(doc))


@api.get("/auth/me", response_model=UserOut)
async def me(user: CurrentUser):
    return user_public(user)


@api.post("/auth/signup", status_code=202)
async def signup(body: SignupIn):
    email = body.email.lower().strip()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=409, detail="An account with this email already exists")
    doc = {
        "email": email,
        "name": body.name.strip() or email,
        "password_hash": password_hash.hash(body.password),
        "role": Role.cashier.value,   # least privilege; admin can change on approval
        "disabled": True,             # blocked until an admin approves
        "pending": True,
        "created_at": now_iso(),
    }
    await db.users.insert_one(doc)
    return {"message": "Account created. An admin must approve it before you can sign in."}


@api.post("/auth/forgot-password", status_code=202)
async def forgot_password(body: ForgotIn):
    email = body.email.lower().strip()
    user = await db.users.find_one({"email": email})
    # Generic response either way (no account enumeration).
    if user and not user.get("disabled", False):
        code = f"{secrets.randbelow(1000000):06d}"
        await db.password_resets.delete_many({"email": email})
        await db.password_resets.insert_one({
            "email": email,
            "code_hash": _reset_code_hash(code),
            "expires_at": datetime.now(timezone.utc) + timedelta(minutes=RESET_TTL_MINUTES),
            "created_at": now_iso(),
        })
        subject = f"Your {EMAIL_FROM_NAME} password reset code"
        html = (
            f'<table role="presentation" width="100%"><tr><td style="padding:24px;'
            f'font-family:Arial,sans-serif;color:#0f172a">'
            f'<p style="font-size:16px">Hi {escape(user.get("name", ""))},</p>'
            f'<p>Use this code to reset your {escape(EMAIL_FROM_NAME)} password. '
            f'It expires in {RESET_TTL_MINUTES} minutes.</p>'
            f'<p style="font-size:32px;font-weight:800;letter-spacing:6px;margin:16px 0">{code}</p>'
            f'<p style="font-size:13px;color:#64748b">If you did not request this, ignore this email. '
            f'We never ask for your password by email.</p>'
            f'<p style="font-size:12px;color:#94a3b8">Sent by {escape(EMAIL_FROM_NAME)}.</p>'
            f'</td></tr></table>'
        )
        try:
            await send_email(to=user["email"], subject=subject, html=html)
        except Exception as e:  # noqa: BLE001
            logger.error(f"reset email failed: {e}")
    return {"message": "If that account exists, a reset code has been emailed."}


@api.post("/auth/reset-password")
async def reset_password(body: ResetIn):
    email = body.email.lower().strip()
    row = await db.password_resets.find_one({
        "email": email,
        "code_hash": _reset_code_hash(body.code.strip()),
        "expires_at": {"$gt": datetime.now(timezone.utc)},
    })
    if not row:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    await db.users.update_one(
        {"email": email},
        {"$set": {"password_hash": password_hash.hash(body.new_password)}},
    )
    await db.password_resets.delete_many({"email": email})
    return {"ok": True}


# ---------------------------------------------------------------------------
# User management (admin)
# ---------------------------------------------------------------------------
@api.get("/users", response_model=List[UserOut])
async def list_users(_: AdminOnly):
    docs = await db.users.find().sort("created_at", 1).to_list(500)
    return [user_public(d) for d in docs]


@api.post("/users", response_model=UserOut, status_code=201)
async def create_user(body: UserCreate, _: AdminOnly):
    existing = await db.users.find_one({"email": body.email.lower()})
    if existing:
        raise HTTPException(status_code=409, detail="Email already exists")
    doc = {
        "email": body.email.lower(),
        "name": body.name,
        "password_hash": password_hash.hash(body.password),
        "role": body.role.value,
        "disabled": False,
        "created_at": now_iso(),
    }
    res = await db.users.insert_one(doc)
    doc["_id"] = res.inserted_id
    return user_public(doc)


@api.put("/users/{user_id}", response_model=UserOut)
async def update_user(user_id: str, body: UserUpdate, admin: AdminOnly):
    if not ObjectId.is_valid(user_id):
        raise HTTPException(status_code=404, detail="User not found")
    update = {}
    if body.email is not None:
        new_email = str(body.email).lower().strip()
        existing = await db.users.find_one({"email": new_email, "_id": {"$ne": ObjectId(user_id)}})
        if existing:
            raise HTTPException(status_code=409, detail="Email already exists")
        update["email"] = new_email
    if body.name is not None:
        update["name"] = body.name
    if body.role is not None:
        update["role"] = body.role.value
    if body.disabled is not None:
        update["disabled"] = body.disabled
        if body.disabled is False:
            update["pending"] = False  # approving a pending signup
    if body.password:
        update["password_hash"] = password_hash.hash(body.password)
    if update:
        await db.users.update_one({"_id": ObjectId(user_id)}, {"$set": update})
    doc = await db.users.find_one({"_id": ObjectId(user_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="User not found")
    return user_public(doc)


@api.delete("/users/{user_id}")
async def delete_user(user_id: str, admin: AdminOnly):
    if str(admin["_id"]) == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    await db.users.update_one({"_id": ObjectId(user_id)}, {"$set": {"disabled": True}})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------
def product_public(d: dict) -> ProductOut:
    return ProductOut(
        id=oid(d["_id"]), name=d["name"], barcode=d.get("barcode", ""),
        purchase_price=max(0.0, float(d.get("purchase_price", 0) or 0)),
        sale_price=max(0.0, float(d.get("sale_price", 0) or 0)),
        low_stock_threshold=max(0.0, float(d.get("low_stock_threshold", 5) or 0)),
        expiry_date=d.get("expiry_date"),
        cost_layers=[
            {"quantity": round(float(x.get("quantity", 0) or 0), 8), "unit_cost": round(float(x.get("unit_cost", 0) or 0), 8), "purchase_id": x.get("purchase_id")}
            for x in (d.get("cost_layers") or []) if float(x.get("quantity", 0) or 0) > 1e-9
        ],
        # Negative quantity is valid only for an explicit forced sale; keep it visible so inventory shows the real deficit.
        quantity=float(d.get("quantity", 0) or 0),
        created_at=d.get("created_at", ""), updated_at=d.get("updated_at", ""),
    )


@api.get("/products", response_model=List[ProductOut])
async def list_products(_: AnyUser):
    docs = await db.products.find({"deleted": {"$ne": True}}).sort("name", 1).to_list(2000)
    return [product_public(d) for d in docs]


@api.get("/products/lookup", response_model=Optional[ProductOut])
async def lookup_product(_: AnyUser, barcode: str):
    code = barcode.strip()
    if not code:
        return None
    doc = await db.products.find_one({"barcode": code, "deleted": {"$ne": True}})
    return product_public(doc) if doc else None


@api.post("/products", response_model=ProductOut, status_code=201)
async def create_product(body: ProductIn, _: Staff):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Product name is required")
    if any(float(v) < 0 for v in (body.purchase_price, body.sale_price, body.low_stock_threshold)):
        raise HTTPException(status_code=400, detail="Product prices and stock threshold cannot be negative")
    barcode = body.barcode.strip()
    duplicate = await db.products.find_one({
        "$or": [
            {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}},
            *([{"barcode": barcode}] if barcode else []),
        ],
        "deleted": {"$ne": True},
    })
    if duplicate:
        return product_public(duplicate)
    ts = now_iso()
    doc = body.model_dump()
    doc.update({"name": name, "barcode": barcode, "quantity": 0.0, "deleted": False, "created_at": ts, "updated_at": ts})
    res = await db.products.insert_one(doc)
    doc["_id"] = res.inserted_id
    return product_public(doc)


@api.put("/products/{product_id}", response_model=ProductOut)
async def update_product(product_id: str, body: ProductIn, _: Staff):
    if not ObjectId.is_valid(product_id):
        raise HTTPException(status_code=404, detail="Product not found")
    existing = await db.products.find_one({"_id": ObjectId(product_id), "deleted": {"$ne": True}})
    if not existing:
        raise HTTPException(status_code=404, detail="Product not found")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Product name is required")
    if any(float(v) < 0 for v in (body.purchase_price, body.sale_price, body.low_stock_threshold)):
        raise HTTPException(status_code=400, detail="Product prices and stock threshold cannot be negative")
    barcode = body.barcode.strip()
    if barcode:
        duplicate = await db.products.find_one({"barcode": barcode, "deleted": {"$ne": True}})
        if duplicate and str(duplicate.get("_id")) != product_id:
            raise HTTPException(status_code=409, detail="A product with this barcode already exists")
    update = body.model_dump()
    update.update({"name": name, "barcode": barcode, "updated_at": now_iso()})
    # Never overwrite quantity while editing product master data.
    await db.products.update_one({"_id": ObjectId(product_id)}, {"$set": update})
    doc = await db.products.find_one({"_id": ObjectId(product_id), "deleted": {"$ne": True}})
    return product_public(doc)


@api.delete("/products/{product_id}")
async def delete_product(product_id: str, _: AdminOnly):
    if not ObjectId.is_valid(product_id):
        raise HTTPException(status_code=404, detail="Product not found")
    product = await db.products.find_one({"_id": ObjectId(product_id), "deleted": {"$ne": True}})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    await db.products.update_one(
        {"_id": ObjectId(product_id)}, {"$set": {"deleted": True, "updated_at": now_iso()}}
    )
    return {"ok": True}


@api.post("/inventory-adjustments")
async def create_inventory_adjustment(body: InventoryAdjustmentIn, user: Staff):
    if not ObjectId.is_valid(body.product_id):
        raise HTTPException(status_code=404, detail="Product not found")
    delta = float(body.delta)
    if abs(delta) < 1e-9:
        raise HTTPException(status_code=400, detail="Adjustment quantity cannot be zero")
    product = await db.products.find_one({"_id": ObjectId(body.product_id), "deleted": {"$ne": True}})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    layers = await _ensure_cost_layers(product)
    current = float(product.get("quantity", 0) or 0)
    if delta < 0:
        layers, _ = _consume_cost_layers(layers, -delta)
    else:
        layers = _append_cost_layer(layers, delta, float(product.get("purchase_price", 0) or 0), None)
    next_qty = current + delta
    if next_qty < -1e-9:
        raise HTTPException(status_code=400, detail="Adjustment cannot reduce stock below zero")
    ts = now_iso()
    await db.products.update_one({"_id": ObjectId(body.product_id)}, {"$set": {
        "quantity": round(max(0, next_qty), 8), "cost_layers": layers, "updated_at": ts
    }})
    await db.inventory_adjustments.insert_one({
        "product_id": body.product_id, "delta": delta, "reason": body.reason.strip(),
        "user_id": oid(user["_id"]), "user_name": user.get("name", ""), "created_at": ts, "deleted": False,
    })
    return {"ok": True, "product": product_public({**product, "quantity": max(0, next_qty), "cost_layers": layers, "updated_at": ts})}


@api.post("/stock-transfers")
async def create_stock_transfer(body: StockTransferIn, user: Staff):
    if not ObjectId.is_valid(body.from_product_id) or not ObjectId.is_valid(body.to_product_id):
        raise HTTPException(status_code=404, detail="Product not found")
    if body.from_product_id == body.to_product_id:
        raise HTTPException(status_code=400, detail="Source and destination must be different products")
    source = await db.products.find_one({"_id": ObjectId(body.from_product_id), "deleted": {"$ne": True}})
    target = await db.products.find_one({"_id": ObjectId(body.to_product_id), "deleted": {"$ne": True}})
    if not source or not target:
        raise HTTPException(status_code=404, detail="Source or destination product not found")
    qty = float(body.quantity)
    source_layers = await _ensure_cost_layers(source)
    target_layers = await _ensure_cost_layers(target)
    if qty > float(source.get("quantity", 0) or 0) + 1e-9:
        raise HTTPException(status_code=400, detail="Transfer quantity exceeds available stock")
    remaining = qty
    moved_layers = []
    kept_layers = []
    for layer in source_layers:
        q = float(layer.get("quantity", 0) or 0)
        take = min(q, remaining)
        if take > 0:
            moved_layers.append({**layer, "quantity": take, "purchase_id": None})
            remaining -= take
        left = q - take
        if left > 1e-9:
            kept_layers.append({**layer, "quantity": left})
        if remaining <= 1e-9:
            idx = source_layers.index(layer)
            kept_layers.extend(source_layers[idx + 1:])
            break
    if remaining > 1e-9:
        raise HTTPException(status_code=400, detail="Inventory cost layers are inconsistent with stock")
    ts = now_iso()
    await db.products.update_one({"_id": ObjectId(source["_id"])}, {"$set": {
        "quantity": round(float(source.get("quantity", 0)) - qty, 8), "cost_layers": kept_layers, "updated_at": ts
    }})
    await db.products.update_one({"_id": ObjectId(target["_id"])}, {"$set": {
        "quantity": round(float(target.get("quantity", 0)) + qty, 8), "cost_layers": [*target_layers, *moved_layers], "updated_at": ts
    }})
    await db.stock_transfers.insert_one({
        "from_product_id": body.from_product_id, "to_product_id": body.to_product_id, "quantity": qty,
        "reason": body.reason.strip(), "user_id": oid(user["_id"]), "user_name": user.get("name", ""),
        "created_at": ts, "deleted": False,
    })
    return {"ok": True, "quantity": qty}


# ---------------------------------------------------------------------------
# Parties (suppliers + customers)
# ---------------------------------------------------------------------------
def party_public(d: dict, balance: float = 0.0) -> PartyOut:
    return PartyOut(
        id=oid(d["_id"]), name=d["name"], type=d["type"],
        phone=d.get("phone", ""), address=d.get("address", ""),
        created_at=d.get("created_at", ""), balance=round(balance, 2),
    )


async def _party_balances() -> dict:
    """Compute owed balances per party id.
    supplier payable = purchases total − payments(pay) settled.
    customer receivable = credit sales total − payments(receive) settled.
    (settled = cash amount + adjustment)
    """
    balances: dict = {}
    purchases = await db.purchases.find({"deleted": {"$ne": True}}).to_list(20000)
    for p in purchases:
        sid = p.get("supplier_id")
        if sid:
            balances[sid] = balances.get(sid, 0.0) + p.get("total", 0)
    # Supplier returns reduce the amount still owed to the supplier.
    purchase_returns = await db.purchase_returns.find({"deleted": {"$ne": True}}).to_list(20000)
    for r in purchase_returns:
        sid = r.get("supplier_id")
        if sid:
            balances[sid] = balances.get(sid, 0.0) - r.get("refund_total", 0)
    credit_sales = await db.sales.find({"deleted": {"$ne": True}, "credit": True}).to_list(20000)
    for s in credit_sales:
        cid = s.get("customer_id")
        if cid:
            balances[cid] = balances.get(cid, 0.0) + s.get("total", 0)
    # Customer returns reduce what the customer owes.
    sales_returns = await db.returns.find({"deleted": {"$ne": True}}).to_list(20000)
    for r in sales_returns:
        cid = r.get("customer_id")
        if cid:
            balances[cid] = balances.get(cid, 0.0) - r.get("refund_total", 0)
    payments = await db.payments.find({"deleted": {"$ne": True}}).to_list(20000)
    for pay in payments:
        pid = pay.get("party_id")
        if not pid:
            continue
        kind = pay.get("kind")
        if kind in ("pay", "receive"):
            # Settling what is owed reduces the outstanding balance.
            settled = float(pay.get("amount", 0) or 0) + float(pay.get("adjustment", 0) or 0)
            balances[pid] = balances.get(pid, 0.0) - settled
        elif kind in ("supplier_refund", "customer_refund"):
            # A cash refund clears the credit/receivable that a return created
            # (which had pushed the balance negative), moving it back toward 0.
            amt = float(pay.get("amount", 0) or 0)
            balances[pid] = balances.get(pid, 0.0) + amt
    return balances


@api.get("/parties", response_model=List[PartyOut])
async def list_parties(_: AnyUser, type: Optional[PartyType] = None):
    q: dict = {"deleted": {"$ne": True}}
    if type:
        q["type"] = type.value
    docs = await db.parties.find(q).sort("name", 1).to_list(2000)
    balances = await _party_balances()
    return [party_public(d, balances.get(oid(d["_id"]), 0.0)) for d in docs]


def _party_name_key(value: str) -> str:
    # Stable, human-friendly duplicate key: ignore case, spaces and punctuation.
    return re.sub(r"[^\w]+", "", (value or "").strip().casefold(), flags=re.UNICODE)

def _party_phone_key(value: str) -> str:
    return re.sub(r"\D+", "", value or "")

@api.post("/parties", status_code=201)
async def create_party(body: PartyIn, _: Staff):
    name = body.name.strip()
    phone = body.phone.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Party name is required")

    name_key = _party_name_key(name)
    phone_key = _party_phone_key(phone)

    # Server-side dedupe is mandatory because two phones/devices can sync the
    # same offline-created party. Never match an empty phone.
    existing_rows = await db.parties.find({
        "type": body.type.value,
        "deleted": {"$ne": True},
    }).to_list(10000)
    for existing in existing_rows:
        existing_name_key = _party_name_key(str(existing.get("name", "")))
        existing_phone_key = _party_phone_key(str(existing.get("phone", "")))
        if (phone_key and existing_phone_key and phone_key == existing_phone_key) or (
            name_key and existing_name_key and name_key == existing_name_key
        ):
            return {**party_public(existing), "existing": True}

    doc = {
        "name": name,
        "type": body.type.value,
        "phone": phone,
        "address": body.address.strip(),
        "dedupe_name_key": name_key,
        "dedupe_phone_key": phone_key,
        "deleted": False,
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    res = await db.parties.insert_one(doc)
    doc["_id"] = res.inserted_id
    return {**party_public(doc), "existing": False}


@api.put("/parties/{party_id}", response_model=PartyOut)
async def update_party(party_id: str, body: PartyIn, _: AdminOnly):
    if not ObjectId.is_valid(party_id):
        raise HTTPException(status_code=404, detail="Party not found")
    update = body.model_dump()
    update["type"] = body.type.value
    await db.parties.update_one({"_id": ObjectId(party_id)}, {"$set": update})
    doc = await db.parties.find_one({"_id": ObjectId(party_id)})
    return party_public(doc)


@api.delete("/parties/{party_id}")
async def delete_party(party_id: str, _: AdminOnly):
    await db.parties.update_one({"_id": ObjectId(party_id)}, {"$set": {"deleted": True}})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Payments ledger (supplier "pay" / customer "receive")
# ---------------------------------------------------------------------------
def payment_public(d: dict) -> dict:
    return {
        "id": oid(d["_id"]),
        "party_id": d.get("party_id"),
        "party_name": d.get("party_name", ""),
        "party_type": d.get("party_type", ""),
        "kind": d.get("kind"),
        "amount": d.get("amount", 0),
        "adjustment": d.get("adjustment", 0),
        "note": d.get("note", ""),
        "user_name": d.get("user_name", ""),
        "created_at": d.get("created_at"),
    }


@api.get("/payments")
async def list_payments(_: Staff, party_id: Optional[str] = None, limit: int = Query(10000, le=10000)):
    q: dict = {"deleted": {"$ne": True}}
    if party_id:
        q["party_id"] = party_id
    docs = await db.payments.find(q).sort("created_at", -1).to_list(limit)
    return [payment_public(d) for d in docs]


@api.post("/payments", status_code=201)
async def create_payment(body: PaymentIn, user: Staff):
    if not ObjectId.is_valid(body.party_id):
        raise HTTPException(status_code=404, detail="Party not found")
    party = await db.parties.find_one({"_id": ObjectId(body.party_id), "deleted": {"$ne": True}})
    if not party:
        raise HTTPException(status_code=404, detail="Party not found")
    # PaymentIn enforces non-negative cash and adjustment values.
    # supplier -> pay, customer -> receive
    if party["type"] == "supplier" and body.kind not in (PaymentKind.pay, PaymentKind.supplier_refund):
        raise HTTPException(status_code=400, detail="Use 'pay' or 'supplier_refund' for a supplier")
    if party["type"] == "customer" and body.kind not in (PaymentKind.receive, PaymentKind.customer_refund):
        raise HTTPException(status_code=400, detail="Use 'receive' or 'customer_refund' for a customer")
    doc = {
        "party_id": body.party_id,
        "party_name": party["name"],
        "party_type": party["type"],
        "kind": body.kind.value,
        "amount": round(body.amount, 2),
        "adjustment": round(body.adjustment, 2),
        "note": body.note,
        "user_name": user.get("name", user["email"]),
        "deleted": False,
        "created_at": now_iso(),
    }
    res = await db.payments.insert_one(doc)
    doc["_id"] = res.inserted_id
    return payment_public(doc)


@api.delete("/payments/{payment_id}")
async def delete_payment(payment_id: str, _: AdminOnly):
    if not ObjectId.is_valid(payment_id):
        raise HTTPException(status_code=404, detail="Payment not found")
    await db.payments.update_one({"_id": ObjectId(payment_id)}, {"$set": {"deleted": True}})
    return {"ok": True}


@api.put("/payments/{payment_id}")
async def edit_payment(payment_id: str, body: PaymentIn, _: AdminOnly):
    if not ObjectId.is_valid(payment_id): raise HTTPException(status_code=404, detail="Payment not found")
    existing = await db.payments.find_one({"_id": ObjectId(payment_id), "deleted": {"$ne": True}})
    if not existing: raise HTTPException(status_code=404, detail="Payment not found")
    if not ObjectId.is_valid(body.party_id): raise HTTPException(status_code=404, detail="Party not found")
    party = await db.parties.find_one({"_id": ObjectId(body.party_id), "deleted": {"$ne": True}})
    if not party: raise HTTPException(status_code=404, detail="Party not found")
    allowed = ("pay", "supplier_refund") if party["type"] == "supplier" else ("receive", "customer_refund")
    if body.kind.value not in allowed: raise HTTPException(status_code=400, detail=f"Use one of {', '.join(allowed)} for this party")
    update={"party_id":body.party_id,"party_name":party["name"],"party_type":party["type"],"kind":body.kind.value,"amount":round(body.amount,2),"adjustment":round(body.adjustment,2),"note":body.note,"edited_at":now_iso()}
    await db.payments.update_one({"_id": ObjectId(payment_id)}, {"$set": update})
    return payment_public(await db.payments.find_one({"_id": ObjectId(payment_id)}))


# ---------------------------------------------------------------------------
# Expense budget (single monthly target)
# ---------------------------------------------------------------------------
@api.get("/budget")
async def get_budget(_: Staff):
    doc = await db.budget.find_one({"_id": "singleton"})
    monthly = doc.get("monthly_amount", 0.0) if doc else 0.0
    opening = doc.get("opening_amount", 0.0) if doc else 0.0
    start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    month_expenses = await db.expenses.find(
        {"deleted": {"$ne": True}, "created_at": {"$gte": start.isoformat()}}
    ).to_list(10000)
    spent = round(sum(e.get("amount", 0) for e in month_expenses), 2)
    purchase_docs = await db.purchases.find({"deleted": {"$ne": True}}).to_list(20000)
    purchase_spent = round(sum(p.get("total", 0) for p in purchase_docs), 2)
    return {"monthly_amount": round(monthly, 2), "opening_amount": round(opening, 2), "spent_this_month": spent, "purchase_spent": purchase_spent, "purchase_remaining": round(max(0.0, opening - purchase_spent), 2)}


@api.put("/budget")
async def set_budget(body: BudgetIn, _: AdminOnly):
    await db.budget.update_one(
        {"_id": "singleton"},
        {"$set": {"monthly_amount": round(max(0.0, body.monthly_amount), 2), **({"opening_amount": round(max(0.0, body.opening_amount), 2)} if body.opening_amount is not None else {})}},
        upsert=True,
    )
    return await get_budget(_)


# ---------------------------------------------------------------------------
# Sales (cart) + reprint
# ---------------------------------------------------------------------------
def sale_public(d: dict) -> dict:
    return {
        "id": oid(d["_id"]),
        "invoice_no": d.get("invoice_no"),
        "serial_no": d.get("serial_no"),
        "items": d.get("items", []),
        "customer_id": d.get("customer_id"),
        "customer_name": d.get("customer_name", "Walk-in"),
        "subtotal": d.get("subtotal", 0),
        "discount": d.get("discount", 0),
        "total": d.get("total", 0),
        "cogs": d.get("cogs", 0),
        "profit": d.get("profit", 0),
        "note": d.get("note", ""),
        "cashier_id": d.get("cashier_id"),
        "cashier_name": d.get("cashier_name", ""),
        "credit": d.get("credit", False),
        "created_at": d.get("created_at"),
    }


@api.get("/sales")
async def list_sales(_: AnyUser, limit: int = Query(10000, le=10000)):
    docs = await db.sales.find({"deleted": {"$ne": True}}).sort("created_at", -1).to_list(limit)
    return [sale_public(d) for d in docs]


@api.get("/sales/{sale_id}")
async def get_sale(sale_id: str, _: AnyUser):
    if not ObjectId.is_valid(sale_id):
        raise HTTPException(status_code=404, detail="Sale not found")
    doc = await db.sales.find_one({"_id": ObjectId(sale_id), "deleted": {"$ne": True}})
    if not doc:
        raise HTTPException(status_code=404, detail="Sale not found")
    result = sale_public(doc)
    rets = await db.returns.find({"sale_id": sale_id, "deleted": {"$ne": True}}).to_list(1000)
    returned: dict = {}
    for r in rets:
        for it in r.get("items", []):
            returned[it["product_id"]] = returned.get(it["product_id"], 0) + it["quantity"]
    result["returned_items"] = returned
    result["returned_total"] = round(sum(r.get("refund_total", 0) for r in rets), 2)
    return result


@api.post("/sales", status_code=201)
async def create_sale(body: SaleIn, user: AnyUser):
    if not body.items:
        raise HTTPException(status_code=400, detail="Cart is empty")

    # Validate IDs before constructing ObjectIds so a bad/stale cart entry
    # returns a clean 400 instead of crashing the sale request.
    for it in body.items:
        if not ObjectId.is_valid(it.product_id):
            raise HTTPException(status_code=400, detail="Invalid product in cart")
        if it.quantity <= 0:
            raise HTTPException(status_code=400, detail="Quantity must be greater than zero")
        if not float(it.unit_price) >= 0:
            raise HTTPException(status_code=400, detail="Unit price cannot be negative")

    requested = _aggregate_item_quantities(body.items)
    for product_id, requested_qty in requested.items():
        p = await db.products.find_one({"_id": ObjectId(product_id), "deleted": {"$ne": True}})
        if not p:
            raise HTTPException(status_code=400, detail="Product not found in cart")
        available = float(p.get("quantity", 0) or 0)
        if requested_qty > available and not body.allow_negative_stock:
            raise HTTPException(status_code=400, detail=f"Only {p.get('quantity', 0)} of {p['name']} in stock")
    items = []
    subtotal = 0.0
    cogs = 0.0
    working_cost_layers = {}
    for it in body.items:
        if not ObjectId.is_valid(it.product_id):
            raise HTTPException(status_code=400, detail="Invalid product in cart")
        p = await db.products.find_one({"_id": ObjectId(it.product_id), "deleted": {"$ne": True}})
        if not p:
            raise HTTPException(status_code=400, detail="Product not found in cart")
        if it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Quantity must be > 0 for {p['name']}")
        available = float(p.get("quantity", 0) or 0)
        if it.quantity > available and not body.allow_negative_stock:
            raise HTTPException(status_code=400, detail=f"Only {available:g} of {p['name']} in stock")
        line_total = round(it.quantity * it.unit_price, 2)
        layers = working_cost_layers.get(it.product_id)
        if layers is None:
            layers = await _ensure_cost_layers(p)
        in_stock_qty = min(float(it.quantity), max(0.0, available))
        if in_stock_qty > 0:
            next_layers, line_cogs = _consume_cost_layers(layers, in_stock_qty)
        else:
            next_layers, line_cogs = layers, 0.0
        working_cost_layers[it.product_id] = next_layers
        unit_cost = round(line_cogs / it.quantity, 8) if it.quantity > 0 else 0.0
        subtotal += line_total
        cogs += line_cogs
        items.append({
            "product_id": it.product_id,
            "name": p["name"],
            "quantity": it.quantity,
            "unit_price": it.unit_price,
            "purchase_price": unit_cost,
            "line_cogs": round(line_cogs, 2),
            "line_total": line_total,
        })

    discount = max(0.0, body.discount)
    total = round(max(0.0, subtotal - discount), 2)
    profit = round(total - cogs, 2)

    customer_name = "Walk-in"
    if body.customer_id and ObjectId.is_valid(body.customer_id):
        c = await db.parties.find_one({"_id": ObjectId(body.customer_id)})
        if c:
            customer_name = c["name"]
    # Credit only makes sense with a named customer (someone to owe the money).
    credit = bool(body.credit and body.customer_id)

    seq = await next_seq("sale")
    doc = {
        "invoice_no": f"INV-{seq:05d}",
        "serial_no": seq,
        "items": items,
        "customer_id": body.customer_id,
        "customer_name": customer_name,
        "subtotal": round(subtotal, 2),
        "discount": discount,
        "total": total,
        "cogs": round(cogs, 2),
        "profit": profit,
        "note": body.note,
        "cashier_id": oid(user["_id"]),
        "cashier_name": user.get("name", user["email"]),
        "credit": credit,
        "allow_negative_stock": bool(body.allow_negative_stock),
        "deleted": False,
        "created_at": now_iso(),
    }
    res = await db.sales.insert_one(doc)
    doc["_id"] = res.inserted_id

    for product_id, layers in working_cost_layers.items():
        await _save_cost_layers(product_id, layers)

    for it in body.items:
        await db.products.update_one(
            {"_id": ObjectId(it.product_id)},
            {"$inc": {"quantity": -it.quantity}, "$set": {"updated_at": now_iso()}},
        )
    return sale_public(doc)


async def _sale_returned_map(sale_id: str) -> dict:
    rets = await db.returns.find({"sale_id": sale_id, "deleted": {"$ne": True}}).to_list(1000)
    returned: dict = {}
    for r in rets:
        for it in r.get("items", []):
            returned[it["product_id"]] = returned.get(it["product_id"], 0) + it["quantity"]
    return returned


@api.delete("/sales/{sale_id}")
async def delete_sale(sale_id: str, _: AdminOnly):
    if not ObjectId.is_valid(sale_id):
        raise HTTPException(status_code=404, detail="Sale not found")
    sale = await db.sales.find_one({"_id": ObjectId(sale_id)})
    if not sale or sale.get("deleted"):
        raise HTTPException(status_code=404, detail="Sale not found")
    returned = await _sale_returned_map(sale_id)
    # Restore the stock that is still "out" (sold minus already returned)
    for it in sale.get("items", []):
        restore = it["quantity"] - returned.get(it["product_id"], 0)
        if restore > 0:
            prod = await db.products.find_one({"_id": ObjectId(it["product_id"])})
            layers = await _ensure_cost_layers(prod or {})
            layers = _append_cost_layer(layers, restore, float(it.get("purchase_price", 0) or 0), None)
            await db.products.update_one(
                {"_id": ObjectId(it["product_id"])},
                {"$inc": {"quantity": restore}, "$set": {"cost_layers": layers, "updated_at": now_iso()}},
            )
    # Remove the sale and its returns from the books
    await db.returns.update_many({"sale_id": sale_id}, {"$set": {"deleted": True}})
    await db.sales.update_one({"_id": ObjectId(sale_id)}, {"$set": {"deleted": True}})
    return {"ok": True}


@api.put("/sales/{sale_id}")
async def edit_sale(sale_id: str, body: SaleIn, user: AnyUser):
    if not ObjectId.is_valid(sale_id):
        raise HTTPException(status_code=404, detail="Sale not found")
    sale = await db.sales.find_one({"_id": ObjectId(sale_id)})
    if not sale or sale.get("deleted"):
        raise HTTPException(status_code=404, detail="Sale not found")
    if user["role"] == Role.cashier.value and sale.get("cashier_id") != oid(user["_id"]):
        raise HTTPException(status_code=403, detail="Cashiers can edit only their own sales")
    if not body.items:
        raise HTTPException(status_code=400, detail="Sale must have at least one item")

    returned = await _sale_returned_map(sale_id)
    if returned:
        raise HTTPException(status_code=400, detail="This sale has returns. Handle returns before editing.")

    # Validate the complete new cart before changing stock. Aggregate quantities
    # so the same product can never be deducted twice past available stock.
    requested: dict[str, float] = {}
    for it in body.items:
        if not ObjectId.is_valid(it.product_id):
            raise HTTPException(status_code=400, detail="Invalid product in cart")
        if it.quantity <= 0:
            raise HTTPException(status_code=400, detail="Quantity must be greater than zero")
        if not float(it.unit_price) >= 0:
            raise HTTPException(status_code=400, detail="Unit price cannot be negative")
        requested[it.product_id] = requested.get(it.product_id, 0) + float(it.quantity)

    old_qty: dict[str, float] = {}
    for it in sale.get("items", []):
        old_qty[it["product_id"]] = old_qty.get(it["product_id"], 0) + float(it.get("quantity", 0))

    for product_id, requested_qty in requested.items():
        p = await db.products.find_one({"_id": ObjectId(product_id), "deleted": {"$ne": True}})
        if not p:
            raise HTTPException(status_code=400, detail="Product not found in cart")
        available_after_restore = float(p.get("quantity", 0) or 0) + old_qty.get(product_id, 0)
        if requested_qty > available_after_restore and not body.allow_negative_stock:
            raise HTTPException(status_code=400, detail=f"Only {available_after_restore:g} of {p['name']} available for this sale")

    # Put back the old items at their recorded sale cost.
    for it in sale.get("items", []):
        prod = await db.products.find_one({"_id": ObjectId(it["product_id"])})
        layers = await _ensure_cost_layers(prod or {})
        layers = _append_cost_layer(layers, float(it["quantity"]), float(it.get("purchase_price", 0) or 0), None)
        await db.products.update_one(
            {"_id": ObjectId(it["product_id"])},
            {"$inc": {"quantity": it["quantity"]}, "$set": {"cost_layers": layers, "updated_at": now_iso()}},
        )

    items = []
    subtotal = 0.0
    cogs = 0.0
    working_cost_layers = {}
    try:
        for it in body.items:
            if not ObjectId.is_valid(it.product_id):
                raise HTTPException(status_code=400, detail="Invalid product in cart")
            p = await db.products.find_one({"_id": ObjectId(it.product_id), "deleted": {"$ne": True}})
            if not p:
                raise HTTPException(status_code=400, detail="Product not found in cart")
            if it.quantity <= 0:
                raise HTTPException(status_code=400, detail=f"Quantity must be > 0 for {p['name']}")
            available = float(p.get("quantity", 0) or 0)
            if it.quantity > available and not body.allow_negative_stock:
                raise HTTPException(status_code=400, detail=f"Only {available:g} of {p['name']} in stock")
            line_total = round(it.quantity * it.unit_price, 2)
            layers = working_cost_layers.get(it.product_id)
            if layers is None:
                layers = await _ensure_cost_layers(p)
            in_stock_qty = min(float(it.quantity), max(0.0, available))
            if in_stock_qty > 0:
                next_layers, line_cogs = _consume_cost_layers(layers, in_stock_qty)
            else:
                next_layers, line_cogs = layers, 0.0
            working_cost_layers[it.product_id] = next_layers
            unit_cost = round(line_cogs / it.quantity, 8) if it.quantity > 0 else 0.0
            subtotal += line_total
            cogs += line_cogs
            items.append({
                "product_id": it.product_id,
                "name": p["name"],
                "quantity": it.quantity,
                "unit_price": it.unit_price,
                "purchase_price": unit_cost,
                "line_cogs": round(line_cogs, 2),
                "line_total": line_total,
            })
    except HTTPException:
        # roll back the stock we just restored so nothing is lost
        for it in sale.get("items", []):
            await db.products.update_one(
                {"_id": ObjectId(it["product_id"])},
                {"$inc": {"quantity": -it["quantity"]}, "$set": {"updated_at": now_iso()}},
            )
        raise

    discount = max(0.0, body.discount)
    total = round(max(0.0, subtotal - discount), 2)

    customer_name = "Walk-in"
    if body.customer_id and ObjectId.is_valid(body.customer_id):
        c = await db.parties.find_one({"_id": ObjectId(body.customer_id)})
        if c:
            customer_name = c["name"]

    await db.sales.update_one(
        {"_id": ObjectId(sale_id)},
        {"$set": {
            "items": items,
            "customer_id": body.customer_id,
            "customer_name": customer_name,
            "subtotal": round(subtotal, 2),
            "discount": discount,
            "total": total,
            "cogs": round(cogs, 2),
            "profit": round(total - cogs, 2),
            "note": body.note,
            "allow_negative_stock": bool(body.allow_negative_stock),
            "edited_at": now_iso(),
        }},
    )
    # Commit the remaining cost layers selected above.
    for product_id, layers in working_cost_layers.items():
        await _save_cost_layers(product_id, layers)
        await db.products.update_one(
            {"_id": ObjectId(product_id)},
            {"$set": {"updated_at": now_iso()}},
        )
    updated = await db.sales.find_one({"_id": ObjectId(sale_id)})
    return sale_public(updated)


# ---------------------------------------------------------------------------
# Purchases (multi-item restock, editable cost)
# ---------------------------------------------------------------------------
def purchase_public(d: dict) -> dict:
    return {
        "id": oid(d["_id"]),
        "ref_no": d.get("ref_no"),
        "items": d.get("items", []),
        "supplier_id": d.get("supplier_id"),
        "supplier_name": d.get("supplier_name", "—"),
        "total": d.get("total", 0),
        "note": d.get("note", ""),
        "user_name": d.get("user_name", ""),
        "created_at": d.get("created_at"),
    }


@api.get("/purchases")
async def list_purchases(_: Staff, limit: int = Query(200, le=1000)):
    docs = await db.purchases.find({"deleted": {"$ne": True}}).sort("created_at", -1).to_list(limit)
    return [purchase_public(d) for d in docs]


@api.get("/purchases/{purchase_id}")
async def get_purchase(purchase_id: str, _: Staff):
    if not ObjectId.is_valid(purchase_id):
        raise HTTPException(status_code=404, detail="Purchase not found")
    doc = await db.purchases.find_one({"_id": ObjectId(purchase_id), "deleted": {"$ne": True}})
    if not doc:
        raise HTTPException(status_code=404, detail="Purchase not found")
    result = purchase_public(doc)
    rets = await db.purchase_returns.find({"purchase_id": purchase_id, "deleted": {"$ne": True}}).to_list(1000)
    returned: dict = {}
    for r in rets:
        for it in r.get("items", []):
            returned[it["product_id"]] = returned.get(it["product_id"], 0) + it["quantity"]
    result["returned_items"] = returned
    result["returned_total"] = round(sum(r.get("refund_total", 0) for r in rets), 2)
    return result


@api.post("/purchases", status_code=201)
async def create_purchase(body: PurchaseIn, user: Staff):
    if not body.supplier_id or not ObjectId.is_valid(body.supplier_id):
        raise HTTPException(status_code=400, detail="Supplier is required for every purchase")
    if not body.items:
        raise HTTPException(status_code=400, detail="No products to purchase")
    items = []
    total = 0.0
    for it in body.items:
        if not ObjectId.is_valid(it.product_id):
            raise HTTPException(status_code=400, detail="Invalid product")
        p = await db.products.find_one({"_id": ObjectId(it.product_id), "deleted": {"$ne": True}})
        if not p:
            raise HTTPException(status_code=400, detail="Product not found")
        if it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Quantity must be > 0 for {p['name']}")
        line_total = round(it.quantity * it.unit_cost, 2)
        total += line_total
        items.append({
            "product_id": it.product_id,
            "name": p["name"],
            "quantity": it.quantity,
            "unit_cost": it.unit_cost,
            "line_total": line_total,
        })

    supplier_name = "—"
    if body.supplier_id and ObjectId.is_valid(body.supplier_id):
        s = await db.parties.find_one({"_id": ObjectId(body.supplier_id)})
        if s:
            supplier_name = s["name"]

    seq = await next_seq("purchase")
    doc = {
        "ref_no": f"PO-{seq:05d}",
        "items": items,
        "supplier_id": body.supplier_id,
        "supplier_name": supplier_name,
        "total": round(total, 2),
        "note": body.note,
        "user_name": user.get("name", user["email"]),
        "deleted": False,
        "created_at": now_iso(),
    }
    res = await db.purchases.insert_one(doc)
    doc["_id"] = res.inserted_id

    for it in body.items:
        product = await db.products.find_one({"_id": ObjectId(it.product_id), "deleted": {"$ne": True}})
        layers = await _ensure_cost_layers(product or {})
        layers = _append_cost_layer(layers, it.quantity, it.unit_cost, oid(doc["_id"]))
        await db.products.update_one(
            {"_id": ObjectId(it.product_id)},
            {"$inc": {"quantity": it.quantity},
             "$set": {"purchase_price": it.unit_cost, "cost_layers": layers, "updated_at": now_iso()}},
        )
    return purchase_public(doc)


async def _purchase_returned_map(purchase_id: str) -> dict:
    rets = await db.purchase_returns.find(
        {"purchase_id": purchase_id, "deleted": {"$ne": True}}
    ).to_list(1000)
    returned: dict = {}
    for r in rets:
        for it in r.get("items", []):
            returned[it["product_id"]] = returned.get(it["product_id"], 0) + it["quantity"]
    return returned


@api.delete("/purchases/{purchase_id}")
async def delete_purchase(purchase_id: str, _: AdminOnly):
    if not ObjectId.is_valid(purchase_id):
        raise HTTPException(status_code=404, detail="Purchase not found")
    purchase = await db.purchases.find_one({"_id": ObjectId(purchase_id)})
    if not purchase or purchase.get("deleted"):
        raise HTTPException(status_code=404, detail="Purchase not found")
    returned = await _purchase_returned_map(purchase_id)  # product_id -> qty returned to supplier
    # Check we can safely reverse the stock still in inventory (bought − returned).
    for it in purchase.get("items", []):
        net_in = float(it["quantity"]) - float(returned.get(it["product_id"], 0))
        if net_in <= 0:
            continue
        prod = await db.products.find_one({"_id": ObjectId(it["product_id"])})
        available = float(prod.get("quantity", 0)) if prod else 0
        if available + 1e-9 < net_in:
            raise HTTPException(status_code=400, detail=f"Cannot delete purchase: {it['name']} stock has already been used")
    # Reverse only this purchase's remaining cost lot.
    for it in purchase.get("items", []):
        net_in = float(it["quantity"]) - float(returned.get(it["product_id"], 0))
        if net_in > 0:
            prod = await db.products.find_one({"_id": ObjectId(it["product_id"])})
            layers = await _ensure_cost_layers(prod or {})
            layers, _ = _consume_cost_layers_matching(layers, net_in, float(it.get("unit_cost", 0) or 0))
            await db.products.update_one(
                {"_id": ObjectId(it["product_id"])},
                {"$inc": {"quantity": -net_in}, "$set": {"cost_layers": layers, "updated_at": now_iso()}},
            )
    # Cascade: remove this purchase's supplier returns from the books too.
    await db.purchase_returns.update_many({"purchase_id": purchase_id}, {"$set": {"deleted": True}})
    await db.purchases.update_one({"_id": ObjectId(purchase_id)}, {"$set": {"deleted": True}})
    return {"ok": True}


@api.put("/purchases/{purchase_id}")
async def edit_purchase(purchase_id: str, body: PurchaseIn, _: AdminOnly):
    if not body.supplier_id or not ObjectId.is_valid(body.supplier_id):
        raise HTTPException(status_code=400, detail="Supplier is required for every purchase")
    if not ObjectId.is_valid(purchase_id):
        raise HTTPException(status_code=404, detail="Purchase not found")
    purchase = await db.purchases.find_one({"_id": ObjectId(purchase_id)})
    if not purchase or purchase.get("deleted"):
        raise HTTPException(status_code=404, detail="Purchase not found")
    if not body.items:
        raise HTTPException(status_code=400, detail="Purchase must have at least one item")

    returned = await _purchase_returned_map(purchase_id)
    if returned:
        raise HTTPException(status_code=400, detail="This purchase has supplier returns. Handle them before editing.")

    # Validate before reversing so a failed edit never corrupts stock.
    for it in purchase.get("items", []):
        prod = await db.products.find_one({"_id": ObjectId(it["product_id"])})
        available = float(prod.get("quantity", 0)) if prod else 0
        if available + 1e-9 < float(it["quantity"]):
            raise HTTPException(status_code=400, detail=f"Cannot edit purchase: {it['name']} stock has already been used")
    # Reverse the old purchase's exact cost lot.
    for it in purchase.get("items", []):
        prod = await db.products.find_one({"_id": ObjectId(it["product_id"])})
        layers = await _ensure_cost_layers(prod or {})
        layers, _ = _consume_cost_layers_matching(layers, float(it["quantity"]), float(it.get("unit_cost", 0) or 0))
        await db.products.update_one(
            {"_id": ObjectId(it["product_id"])},
            {"$inc": {"quantity": -it["quantity"]}, "$set": {"cost_layers": layers, "updated_at": now_iso()}},
        )

    items = []
    total = 0.0
    for it in body.items:
        if not ObjectId.is_valid(it.product_id):
            raise HTTPException(status_code=400, detail="Invalid product")
        p = await db.products.find_one({"_id": ObjectId(it.product_id), "deleted": {"$ne": True}})
        if not p:
            raise HTTPException(status_code=400, detail="Product not found")
        if it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Quantity must be > 0 for {p['name']}")
        line_total = round(it.quantity * it.unit_cost, 2)
        total += line_total
        items.append({
            "product_id": it.product_id,
            "name": p["name"],
            "quantity": it.quantity,
            "unit_cost": it.unit_cost,
            "line_total": line_total,
        })

    budget_doc = await db.budget.find_one({"_id": "singleton"})
    opening_budget = float(budget_doc.get("opening_amount", 0)) if budget_doc else 0.0
    if opening_budget > 0:
        purchase_docs = await db.purchases.find({"deleted": {"$ne": True}, "_id": {"$ne": ObjectId(purchase_id)}}).to_list(20000)
        already_spent = sum(float(p.get("total", 0)) for p in purchase_docs)
        if already_spent + total > opening_budget + 0.0001:
            for old_it in purchase.get("items", []):
                await db.products.update_one({"_id": ObjectId(old_it["product_id"])}, {"$inc": {"quantity": old_it["quantity"]}, "$set": {"updated_at": now_iso()}})
            raise HTTPException(status_code=400, detail=f"Purchase exceeds remaining opening budget of {max(0.0, opening_budget - already_spent):.2f}")

    supplier_name = "—"
    if body.supplier_id and ObjectId.is_valid(body.supplier_id):
        s = await db.parties.find_one({"_id": ObjectId(body.supplier_id)})
        if s:
            supplier_name = s["name"]

    await db.purchases.update_one(
        {"_id": ObjectId(purchase_id)},
        {"$set": {
            "items": items,
            "supplier_id": body.supplier_id,
            "supplier_name": supplier_name,
            "total": round(total, 2),
            "note": body.note,
            "edited_at": now_iso(),
        }},
    )
    # Apply the edited purchase as a separate cost layer.
    for it in body.items:
        prod = await db.products.find_one({"_id": ObjectId(it.product_id)})
        layers = await _ensure_cost_layers(prod or {})
        layers = _append_cost_layer(layers, it.quantity, it.unit_cost, purchase_id)
        await db.products.update_one(
            {"_id": ObjectId(it.product_id)},
            {"$inc": {"quantity": it.quantity},
             "$set": {"purchase_price": it.unit_cost, "cost_layers": layers, "updated_at": now_iso()}},
        )
    updated = await db.purchases.find_one({"_id": ObjectId(purchase_id)})
    return purchase_public(updated)


# ---------------------------------------------------------------------------
# Expenses (two buckets)
# ---------------------------------------------------------------------------
def expense_public(d: dict) -> dict:
    return {
        "id": oid(d["_id"]),
        "title": d.get("title"),
        "category": d.get("category", "Other"),
        "bucket": d.get("bucket", "operating"),
        "amount": d.get("amount", 0),
        "note": d.get("note", ""),
        "user_name": d.get("user_name", ""),
        "created_at": d.get("created_at"),
    }


@api.get("/expenses")
async def list_expenses(_: Staff, bucket: Optional[ExpenseBucket] = None):
    q: dict = {"deleted": {"$ne": True}}
    if bucket:
        q["bucket"] = bucket.value
    docs = await db.expenses.find(q).sort("created_at", -1).to_list(1000)
    return [expense_public(d) for d in docs]


@api.post("/expenses", status_code=201)
async def create_expense(body: ExpenseIn, user: Staff):
    doc = body.model_dump()
    doc["bucket"] = body.bucket.value
    doc.update({"deleted": False, "user_name": user.get("name", user["email"]), "created_at": now_iso()})
    res = await db.expenses.insert_one(doc)
    doc["_id"] = res.inserted_id
    return expense_public(doc)


@api.delete("/expenses/{expense_id}")
async def delete_expense(expense_id: str, _: AdminOnly):
    await db.expenses.update_one({"_id": ObjectId(expense_id)}, {"$set": {"deleted": True}})
    return {"ok": True}


@api.put("/expenses/{expense_id}")
async def edit_expense(expense_id: str, body: ExpenseIn, _: AdminOnly):
    if not ObjectId.is_valid(expense_id): raise HTTPException(status_code=404, detail="Expense not found")
    existing = await db.expenses.find_one({"_id": ObjectId(expense_id), "deleted": {"$ne": True}})
    if not existing: raise HTTPException(status_code=404, detail="Expense not found")
    update = body.model_dump(); update["bucket"] = body.bucket.value; update["edited_at"] = now_iso()
    await db.expenses.update_one({"_id": ObjectId(expense_id)}, {"$set": update})
    return expense_public(await db.expenses.find_one({"_id": ObjectId(expense_id)}))


# ---------------------------------------------------------------------------
# Returns / refunds
# ---------------------------------------------------------------------------
def return_public(d: dict) -> dict:
    return {
        "id": oid(d["_id"]),
        "ref_no": d.get("ref_no"),
        "sale_id": d.get("sale_id"),
        "customer_id": d.get("customer_id"),
        "invoice_no": d.get("invoice_no"),
        "customer_name": d.get("customer_name", "Walk-in"),
        "items": d.get("items", []),
        "refund_total": d.get("refund_total", 0),
        "refund_cogs": d.get("refund_cogs", 0),
        "refund_profit": d.get("refund_profit", 0),
        "reason": d.get("reason", ""),
        "user_name": d.get("user_name", ""),
        "created_at": d.get("created_at"),
    }


@api.get("/returns")
async def list_returns(_: Staff, limit: int = Query(200, le=1000)):
    docs = await db.returns.find({"deleted": {"$ne": True}}).sort("created_at", -1).to_list(limit)
    return [return_public(d) for d in docs]


@api.post("/returns", status_code=201)
async def create_return(body: ReturnIn, user: Staff):
    if not ObjectId.is_valid(body.sale_id):
        raise HTTPException(status_code=404, detail="Sale not found")
    sale = await db.sales.find_one({"_id": ObjectId(body.sale_id)})
    if not sale:
        raise HTTPException(status_code=404, detail="Sale not found")

    # How much was already returned per product on this sale
    prev = await db.returns.find({"sale_id": body.sale_id, "deleted": {"$ne": True}}).to_list(1000)
    already: dict = {}
    for r in prev:
        for it in r.get("items", []):
            already[it["product_id"]] = already.get(it["product_id"], 0) + it["quantity"]

    sale_items = {it["product_id"]: it for it in sale.get("items", [])}

    requested = _aggregate_item_quantities(body.items)
    for product_id, requested_qty in requested.items():
        si = sale_items.get(product_id)
        if not si: raise HTTPException(status_code=400, detail="Item was not part of this sale")
        remaining = si["quantity"] - already.get(product_id, 0)
        if requested_qty > remaining: raise HTTPException(status_code=400, detail=f"Only {remaining} of {si['name']} can be returned")
    items = []
    refund_total = 0.0
    refund_cogs = 0.0
    for it in body.items:
        if it.quantity <= 0:
            continue
        si = sale_items.get(it.product_id)
        if not si:
            raise HTTPException(status_code=400, detail="Item was not part of this sale")
        remaining = si["quantity"] - already.get(it.product_id, 0)
        if it.quantity > remaining:
            raise HTTPException(status_code=400, detail=f"Only {remaining} of {si['name']} can be returned")
        line_total = round(it.quantity * si["unit_price"], 2)
        line_cogs = round(it.quantity * si.get("purchase_price", 0), 2)
        refund_total += line_total
        refund_cogs += line_cogs
        items.append({
            "product_id": it.product_id,
            "name": si["name"],
            "quantity": it.quantity,
            "unit_price": si["unit_price"],
            "purchase_price": si.get("purchase_price", 0),
            "line_total": line_total,
        })

    if not items:
        raise HTTPException(status_code=400, detail="Select at least one item to return")

    seq = await next_seq("return")
    doc = {
        "ref_no": f"RET-{seq:05d}",
        "sale_id": body.sale_id,
        "invoice_no": sale.get("invoice_no"),
        "customer_id": sale.get("customer_id"),
        "customer_name": sale.get("customer_name", "Walk-in"),
        "items": items,
        "refund_total": round(refund_total, 2),
        "refund_cogs": round(refund_cogs, 2),
        "refund_profit": round(refund_total - refund_cogs, 2),
        "reason": body.reason,
        "user_name": user.get("name", user["email"]),
        "deleted": False,
        "created_at": now_iso(),
    }
    res = await db.returns.insert_one(doc)
    doc["_id"] = res.inserted_id

    # Restore stock at the exact cost used by the original sale.
    for it in items:
        prod = await db.products.find_one({"_id": ObjectId(it["product_id"])})
        layers = await _ensure_cost_layers(prod or {})
        layers = _append_cost_layer(layers, it["quantity"], float(it.get("purchase_price", 0) or 0), None)
        await db.products.update_one(
            {"_id": ObjectId(it["product_id"])},
            {"$inc": {"quantity": it["quantity"]}, "$set": {"cost_layers": layers, "updated_at": now_iso()}},
        )
    return return_public(doc)


# ---------------------------------------------------------------------------
# Purchase returns (return stock to supplier)
# ---------------------------------------------------------------------------
def purchase_return_public(d: dict) -> dict:
    return {
        "id": oid(d["_id"]),
        "ref_no": d.get("ref_no"),
        "purchase_id": d.get("purchase_id"),
        "supplier_id": d.get("supplier_id"),
        "po_ref": d.get("po_ref"),
        "supplier_name": d.get("supplier_name", "—"),
        "items": d.get("items", []),
        "refund_total": d.get("refund_total", 0),
        "reason": d.get("reason", ""),
        "user_name": d.get("user_name", ""),
        "created_at": d.get("created_at"),
    }


@api.get("/purchase-returns")
async def list_purchase_returns(_: Staff, limit: int = Query(200, le=1000)):
    docs = await db.purchase_returns.find({"deleted": {"$ne": True}}).sort("created_at", -1).to_list(limit)
    return [purchase_return_public(d) for d in docs]


@api.post("/purchase-returns", status_code=201)
async def create_purchase_return(body: PurchaseReturnIn, user: Staff):
    if not ObjectId.is_valid(body.purchase_id):
        raise HTTPException(status_code=404, detail="Purchase not found")
    purchase = await db.purchases.find_one({"_id": ObjectId(body.purchase_id), "deleted": {"$ne": True}})
    if not purchase:
        raise HTTPException(status_code=404, detail="Purchase not found")

    prev = await db.purchase_returns.find({"purchase_id": body.purchase_id, "deleted": {"$ne": True}}).to_list(1000)
    already: dict = {}
    for r in prev:
        for it in r.get("items", []):
            already[it["product_id"]] = already.get(it["product_id"], 0) + it["quantity"]

    po_items = {it["product_id"]: it for it in purchase.get("items", [])}

    requested = _aggregate_item_quantities(body.items)
    for product_id, requested_qty in requested.items():
        pi = po_items.get(product_id)
        if not pi: raise HTTPException(status_code=400, detail="Item was not part of this purchase")
        remaining = pi["quantity"] - already.get(product_id, 0)
        if requested_qty > remaining: raise HTTPException(status_code=400, detail=f"Only {remaining} of {pi['name']} can be returned")
        prod = await db.products.find_one({"_id": ObjectId(product_id)})
        in_stock = float(prod.get("quantity", 0)) if prod else 0
        if requested_qty > in_stock: raise HTTPException(status_code=400, detail=f"Only {in_stock} of {pi['name']} in stock to return")
    items = []
    refund_total = 0.0
    for it in body.items:
        if it.quantity <= 0:
            continue
        pi = po_items.get(it.product_id)
        if not pi:
            raise HTTPException(status_code=400, detail="Item was not part of this purchase")
        remaining = pi["quantity"] - already.get(it.product_id, 0)
        if it.quantity > remaining:
            raise HTTPException(status_code=400, detail=f"Only {remaining} of {pi['name']} can be returned")
        prod = await db.products.find_one({"_id": ObjectId(it.product_id)})
        in_stock = prod.get("quantity", 0) if prod else 0
        if it.quantity > in_stock:
            raise HTTPException(status_code=400, detail=f"Only {in_stock} of {pi['name']} in stock to return")
        line_total = round(it.quantity * pi["unit_cost"], 2)
        refund_total += line_total
        items.append({
            "product_id": it.product_id,
            "name": pi["name"],
            "quantity": it.quantity,
            "unit_cost": pi["unit_cost"],
            "line_total": line_total,
        })

    if not items:
        raise HTTPException(status_code=400, detail="Select at least one item to return")

    seq = await next_seq("purchase_return")
    doc = {
        "ref_no": f"PRET-{seq:05d}",
        "purchase_id": body.purchase_id,
        "po_ref": purchase.get("ref_no"),
        "supplier_id": purchase.get("supplier_id"),
        "supplier_name": purchase.get("supplier_name", "—"),
        "items": items,
        "refund_total": round(refund_total, 2),
        "reason": body.reason,
        "user_name": user.get("name", user["email"]),
        "deleted": False,
        "created_at": now_iso(),
    }
    res = await db.purchase_returns.insert_one(doc)
    doc["_id"] = res.inserted_id

    # Remove the returned units from their purchase-cost layer.
    for it in items:
        prod = await db.products.find_one({"_id": ObjectId(it["product_id"])})
        layers = await _ensure_cost_layers(prod or {})
        layers, _ = _consume_cost_layers_matching(layers, it["quantity"], float(it.get("unit_cost", 0) or 0))
        await db.products.update_one(
            {"_id": ObjectId(it["product_id"])},
            {"$inc": {"quantity": -it["quantity"]}, "$set": {"cost_layers": layers, "updated_at": now_iso()}},
        )
    return purchase_return_public(doc)


@api.put("/returns/{return_id}", status_code=200)
async def edit_return(return_id: str, body: ReturnIn, _: AdminOnly):
    if not ObjectId.is_valid(return_id):
        raise HTTPException(status_code=404, detail="Return not found")
    row = await db.returns.find_one({"_id": ObjectId(return_id), "deleted": {"$ne": True}})
    if not row:
        raise HTTPException(status_code=404, detail="Return not found")
    if not ObjectId.is_valid(body.sale_id) or body.sale_id != row.get("sale_id"):
        raise HTTPException(status_code=400, detail="Return sale cannot be changed")
    sale = await db.sales.find_one({"_id": ObjectId(body.sale_id), "deleted": {"$ne": True}})
    if not sale:
        raise HTTPException(status_code=404, detail="Sale not found")

    for old in row.get("items", []):
        await db.products.update_one({"_id": ObjectId(old["product_id"])}, {"$inc": {"quantity": -old["quantity"]}, "$set": {"updated_at": now_iso()}})

    prev = await db.returns.find({"sale_id": body.sale_id, "deleted": {"$ne": True}, "_id": {"$ne": ObjectId(return_id)}}).to_list(1000)
    already = {}
    for rr in prev:
        for it in rr.get("items", []):
            already[it["product_id"]] = already.get(it["product_id"], 0) + it["quantity"]
    sale_items = {it["product_id"]: it for it in sale.get("items", [])}
    items=[]; refund_total=0.0; refund_cogs=0.0
    try:
        for it in body.items:
            if it.quantity <= 0: continue
            si=sale_items.get(it.product_id)
            if not si: raise HTTPException(status_code=400, detail="Item was not part of this sale")
            remaining=si["quantity"]-already.get(it.product_id,0)
            if it.quantity>remaining: raise HTTPException(status_code=400, detail=f"Only {remaining} of {si['name']} can be returned")
            line_total=round(it.quantity*si["unit_price"],2); line_cogs=round(it.quantity*si.get("purchase_price",0),2)
            refund_total+=line_total; refund_cogs+=line_cogs
            items.append({"product_id":it.product_id,"name":si["name"],"quantity":it.quantity,"unit_price":si["unit_price"],"purchase_price":si.get("purchase_price",0),"line_total":line_total})
        if not items: raise HTTPException(status_code=400, detail="Select at least one item to return")
    except HTTPException:
        for old in row.get("items", []):
            await db.products.update_one({"_id": ObjectId(old["product_id"])}, {"$inc": {"quantity": old["quantity"]}, "$set": {"updated_at": now_iso()}})
        raise
    await db.returns.update_one({"_id": ObjectId(return_id)}, {"$set": {"items":items,"refund_total":round(refund_total,2),"refund_cogs":round(refund_cogs,2),"refund_profit":round(refund_total-refund_cogs,2),"reason":body.reason,"edited_at":now_iso()}})
    for it in items:
        await db.products.update_one({"_id":ObjectId(it["product_id"])},{"$inc":{"quantity":it["quantity"]},"$set":{"updated_at":now_iso()}})
    return return_public(await db.returns.find_one({"_id":ObjectId(return_id)}))


@api.delete("/returns/{return_id}")
async def delete_return(return_id: str, _: AdminOnly):
    if not ObjectId.is_valid(return_id): raise HTTPException(status_code=404, detail="Return not found")
    row = await db.returns.find_one({"_id": ObjectId(return_id), "deleted": {"$ne": True}})
    if not row: raise HTTPException(status_code=404, detail="Return not found")
    for it in row.get("items", []):
        if ObjectId.is_valid(it["product_id"]): await db.products.update_one({"_id": ObjectId(it["product_id"])}, {"$inc": {"quantity": -it["quantity"]}, "$set": {"updated_at": now_iso()}})
    await db.returns.update_one({"_id": ObjectId(return_id)}, {"$set": {"deleted": True, "deleted_at": now_iso()}})
    return {"ok": True}


@api.put("/purchase-returns/{return_id}", status_code=200)
async def edit_purchase_return(return_id: str, body: PurchaseReturnIn, _: AdminOnly):
    if not ObjectId.is_valid(return_id):
        raise HTTPException(status_code=404, detail="Purchase return not found")
    row=await db.purchase_returns.find_one({"_id":ObjectId(return_id),"deleted":{"$ne":True}})
    if not row: raise HTTPException(status_code=404, detail="Purchase return not found")
    if body.purchase_id != row.get("purchase_id"): raise HTTPException(status_code=400, detail="Purchase cannot be changed")
    purchase=await db.purchases.find_one({"_id":ObjectId(body.purchase_id),"deleted":{"$ne":True}})
    if not purchase: raise HTTPException(status_code=404, detail="Purchase not found")
    for old in row.get("items",[]):
        await db.products.update_one({"_id":ObjectId(old["product_id"])},{"$inc":{"quantity":old["quantity"]},"$set":{"updated_at":now_iso()}})
    prev=await db.purchase_returns.find({"purchase_id":body.purchase_id,"deleted":{"$ne":True},"_id":{"$ne":ObjectId(return_id)}}).to_list(1000)
    already={}
    for rr in prev:
        for it in rr.get("items",[]): already[it["product_id"]]=already.get(it["product_id"],0)+it["quantity"]
    po_items={it["product_id"]:it for it in purchase.get("items",[])}
    items=[]; total=0.0
    try:
        for it in body.items:
            if it.quantity<=0: continue
            pi=po_items.get(it.product_id)
            if not pi: raise HTTPException(status_code=400,detail="Item was not part of this purchase")
            remaining=pi["quantity"]-already.get(it.product_id,0)
            if it.quantity>remaining: raise HTTPException(status_code=400,detail=f"Only {remaining} of {pi['name']} can be returned")
            prod=await db.products.find_one({"_id":ObjectId(it.product_id)})
            if it.quantity>(prod.get("quantity",0) if prod else 0): raise HTTPException(status_code=400,detail=f"Not enough {pi['name']} in stock")
            line_total=round(it.quantity*pi["unit_cost"],2); total+=line_total
            items.append({"product_id":it.product_id,"name":pi["name"],"quantity":it.quantity,"unit_cost":pi["unit_cost"],"line_total":line_total})
        if not items: raise HTTPException(status_code=400,detail="Select at least one item to return")
    except HTTPException:
        for old in row.get("items",[]):
            await db.products.update_one({"_id":ObjectId(old["product_id"])},{"$inc":{"quantity":-old["quantity"]},"$set":{"updated_at":now_iso()}})
        raise
    await db.purchase_returns.update_one({"_id":ObjectId(return_id)},{"$set":{"items":items,"refund_total":round(total,2),"reason":body.reason,"edited_at":now_iso()}})
    for it in items:
        await db.products.update_one({"_id":ObjectId(it["product_id"])},{"$inc":{"quantity":-it["quantity"]},"$set":{"updated_at":now_iso()}})
    return purchase_return_public(await db.purchase_returns.find_one({"_id":ObjectId(return_id)}))


@api.delete("/purchase-returns/{return_id}")
async def delete_purchase_return(return_id: str, _: AdminOnly):
    if not ObjectId.is_valid(return_id): raise HTTPException(status_code=404, detail="Purchase return not found")
    row = await db.purchase_returns.find_one({"_id": ObjectId(return_id), "deleted": {"$ne": True}})
    if not row: raise HTTPException(status_code=404, detail="Purchase return not found")
    for it in row.get("items", []):
        if ObjectId.is_valid(it["product_id"]): await db.products.update_one({"_id": ObjectId(it["product_id"])}, {"$inc": {"quantity": it["quantity"]}, "$set": {"updated_at": now_iso()}})
    await db.purchase_returns.update_one({"_id": ObjectId(return_id)}, {"$set": {"deleted": True, "deleted_at": now_iso()}})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------
def range_start(range_: str, tz_offset_minutes: int = 0) -> Optional[datetime]:
    # Convert the device local calendar boundary to UTC so Today/Week/Month
    # match the cashier's local calendar rather than UTC midnight.
    now = datetime.now(timezone.utc)
    local_now = now + timedelta(minutes=tz_offset_minutes)
    if range_ == "today":
        return local_now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(minutes=tz_offset_minutes)
    if range_ == "week":
        start = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        return start - timedelta(days=start.weekday()) - timedelta(minutes=tz_offset_minutes)
    if range_ == "month":
        return local_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0) - timedelta(minutes=tz_offset_minutes)
    if range_ == "year":
        return local_now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0) - timedelta(minutes=tz_offset_minutes)
    return None  # all


@api.get("/reports/inventory-usage")
async def report_inventory_usage(
    _: AnyUser,
    range: str = "month",
    tz_offset_minutes: int = Query(0, ge=-840, le=840),
):
    """Return product usage for the selected local calendar range.

    Usage is net sold quantity: sales add units and customer sale-returns subtract
    returned units. The calculation stays server-side so the mobile Stock screen
    does not load the entire sales history just to render usage analytics.
    """
    start = range_start(range, tz_offset_minutes)
    end = None
    try:
        if range.startswith("date:"):
            value = range.split(":", 1)[1]
            local_day = datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
            start = local_day + timedelta(minutes=tz_offset_minutes)
            end = start + timedelta(days=1)
        elif range.startswith("date-range:"):
            parts = range.split(":")
            if len(parts) != 3:
                raise ValueError
            from_value, to_value = parts[1].strip(), parts[2].strip()
            local_from = datetime.fromisoformat(from_value).replace(tzinfo=timezone.utc) if from_value else None
            local_to = datetime.fromisoformat(to_value).replace(tzinfo=timezone.utc) if to_value else None
            if local_from and local_to and local_to < local_from:
                raise ValueError
            start = local_from + timedelta(minutes=tz_offset_minutes) if local_from else None
            end = (local_to + timedelta(days=1) + timedelta(minutes=tz_offset_minutes)) if local_to else None
    except (ValueError, IndexError):
        raise HTTPException(status_code=400, detail="Invalid date range. Use YYYY-MM-DD.")
    time_q = {"created_at": {}}
    if start:
        time_q["created_at"]["$gte"] = start.isoformat()
    if end:
        time_q["created_at"]["$lt"] = end.isoformat()
    sales = await db.sales.find({**time_q, "deleted": {"$ne": True}}).to_list(20000)
    returns = await db.returns.find({**time_q, "deleted": {"$ne": True}}).to_list(20000)
    products = await db.products.find({"deleted": {"$ne": True}}).to_list(5000)

    usage: dict[str, dict[str, Any]] = {}
    for product in products:
        pid = str(product.get("_id"))
        usage[pid] = {"product_id": pid, "name": product.get("name", ""), "quantity": 0}

    for sale in sales:
        for item in sale.get("items", []) or []:
            pid = str(item.get("product_id") or "")
            if not pid:
                continue
            row = usage.setdefault(pid, {"product_id": pid, "name": item.get("name", ""), "quantity": 0})
            row["quantity"] += max(0, float(item.get("quantity", 0) or 0))
            if not row["name"]:
                row["name"] = item.get("name", "")

    for ret in returns:
        for item in ret.get("items", []) or []:
            pid = str(item.get("product_id") or "")
            if not pid:
                continue
            row = usage.setdefault(pid, {"product_id": pid, "name": item.get("name", ""), "quantity": 0})
            row["quantity"] -= max(0, float(item.get("quantity", 0) or 0))
            if not row["name"]:
                row["name"] = item.get("name", "")

    rows = []
    for row in usage.values():
        row["quantity"] = max(0, int(row["quantity"]))
        rows.append(row)
    active = [row for row in rows if row["quantity"] > 0]
    average = (sum(row["quantity"] for row in active) / len(active)) if active else 0
    rows.sort(key=lambda x: (-x["quantity"], str(x["name"]).lower()))
    for index, row in enumerate(rows):
        qty = row["quantity"]
        row["rank"] = index + 1
        row["level"] = (
            "Low" if qty <= 0 else
            "High" if average > 0 and qty >= average * 1.5 else
            "Low" if average > 0 and qty <= average * 0.5 else
            "Medium"
        )
    return rows


@api.get("/reports/summary")
async def report_summary(_: Staff, range: str = "today", tz_offset_minutes: int = Query(0, ge=-840, le=840), date: Optional[str] = None):
    start = range_start(range, tz_offset_minutes)
    end = None
    try:
        if date:
            local_day = datetime.fromisoformat(date).replace(tzinfo=timezone.utc)
            start = local_day + timedelta(minutes=tz_offset_minutes)
            end = start + timedelta(days=1)
        elif range.startswith("month:"):
            value = range.split(":", 1)[1]
            local_month = datetime.strptime(value, "%Y-%m").replace(tzinfo=timezone.utc)
            start = local_month + timedelta(minutes=tz_offset_minutes)
            if local_month.month == 12:
                next_month = datetime(local_month.year + 1, 1, 1, tzinfo=timezone.utc)
            else:
                next_month = datetime(local_month.year, local_month.month + 1, 1, tzinfo=timezone.utc)
            end = next_month + timedelta(minutes=tz_offset_minutes)
        elif range.startswith("year:"):
            value = range.split(":", 1)[1]
            local_year = datetime.strptime(value, "%Y").replace(tzinfo=timezone.utc)
            start = local_year + timedelta(minutes=tz_offset_minutes)
            end = datetime(local_year.year + 1, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=tz_offset_minutes)
        elif range.startswith("date-range:"):
            parts = range.split(":")
            if len(parts) != 3:
                raise ValueError
            from_value, to_value = parts[1].strip(), parts[2].strip()
            # Convert the user's local calendar dates to UTC boundaries.
            # getTimezoneOffset() is minutes to ADD to local time to obtain UTC.
            local_from = datetime.fromisoformat(from_value).replace(tzinfo=timezone.utc) if from_value else None
            local_to = datetime.fromisoformat(to_value).replace(tzinfo=timezone.utc) if to_value else None
            if local_from and local_to and local_to < local_from:
                raise ValueError
            start = local_from + timedelta(minutes=tz_offset_minutes) if local_from else None
            end = (local_to + timedelta(days=1) + timedelta(minutes=tz_offset_minutes)) if local_to else None
    except (ValueError, IndexError):
        raise HTTPException(status_code=400, detail="Invalid date range. Use YYYY-MM-DD or YYYY-MM.")
    time_q = {"created_at": {"$gte": start.isoformat()}} if start else {}
    if end:
        time_q["created_at"]["$lt"] = end.isoformat()

    # Returns/payments are dated when the cash movement happens. They must
    # therefore be filtered independently from the original sale/purchase;
    # otherwise a return made today against an older invoice disappears from
    # today's cash report.
    sales = await db.sales.find({**time_q, "deleted": {"$ne": True}}).to_list(10000)
    all_sales = await db.sales.find({"deleted": {"$ne": True}}).to_list(20000)
    expenses = await db.expenses.find({**time_q, "deleted": {"$ne": True}}).to_list(10000)
    purchases = await db.purchases.find({**time_q, "deleted": {"$ne": True}}).to_list(10000)
    returns = await db.returns.find({**time_q, "deleted": {"$ne": True}}).to_list(10000)
    purchase_returns = await db.purchase_returns.find({**time_q, "deleted": {"$ne": True}}).to_list(10000)
    products = await db.products.find({"deleted": {"$ne": True}}).to_list(5000)

    gross_revenue = round(sum(s.get("total", 0) for s in sales), 2)
    returns_total = round(sum(r.get("refund_total", 0) for r in returns), 2)
    returns_cogs = round(sum(r.get("refund_cogs", 0) for r in returns), 2)
    revenue = round(gross_revenue - returns_total, 2)  # net sales
    # Gross Profit must match the profit recorded by Sell for every invoice.
    # This preserves sale-level discounts and the exact purchase-cost layer used
    # when the sale was created/edited. Returns reverse the original sale profit.
    stored_sale_profit = round(sum(float(s.get("profit", 0) or 0) for s in sales), 2)
    stored_return_profit = round(sum(float(r.get("refund_profit", 0) or 0) for r in returns), 2)
    gross_profit = round(stored_sale_profit - stored_return_profit, 2)

    cogs_goods = round(sum(s.get("cogs", 0) for s in sales) - returns_cogs, 2)
    units_sold = sum(sum(i.get("quantity", 0) for i in s.get("items", [])) for s in sales)
    transactions = len(sales)

    cogs_expenses = round(sum(e.get("amount", 0) for e in expenses if e.get("bucket") == "cogs"), 2)
    operating_expenses = round(sum(e.get("amount", 0) for e in expenses if e.get("bucket") == "operating"), 2)
    personal_expenses = round(sum(e.get("amount", 0) for e in expenses if e.get("bucket") == "personal"), 2)
    # Keep every profit component explicit before calculating Remaining Balance.
    cogs_total = round(cogs_goods + cogs_expenses, 2)
    total_expenses = round(cogs_expenses + operating_expenses + personal_expenses, 2)

    payments = await db.payments.find({**time_q, "deleted": {"$ne": True}}).to_list(20000)
    supplier_payments = round(sum(p.get("amount", 0) for p in payments if p.get("kind") == "pay"), 2)
    customer_receipts = round(sum(p.get("amount", 0) for p in payments if p.get("kind") == "receive"), 2)
    supplier_refunds = round(sum(p.get("amount", 0) for p in payments if p.get("kind") == "supplier_refund"), 2)
    customer_refunds = round(sum(p.get("amount", 0) for p in payments if p.get("kind") == "customer_refund"), 2)

    # Required store formula:
    # Remaining Balance = Net Sales - Gross Profit - Supplier Payments
    #                   - Operational Expenses - COGS Expenses
    #                   + Supplier Refunds + Opening Purchase Budget
    #                   + Monthly Expenses Budget.
    # Budgets are configured store-level values and are added exactly once
    # to the reported balance, including selected periods and All-Time.
    budget_doc = await db.budget.find_one({"_id": "singleton"})
    opening_purchase_budget = round(float((budget_doc or {}).get("opening_amount", 0) or 0), 2)
    monthly_expenses_budget = round(float((budget_doc or {}).get("monthly_amount", 0) or 0), 2)
    remaining_balance = round(
        revenue
        - gross_profit
        - operating_expenses
        - cogs_expenses
        - supplier_payments
        + supplier_refunds
        + opening_purchase_budget
        + monthly_expenses_budget,
        2,
    )

    purchase_total = round(sum(p.get("total", 0) for p in purchases), 2)
    purchase_returns_total = round(sum(r.get("refund_total", 0) for r in purchase_returns), 2)
    purchase_net = round(purchase_total - purchase_returns_total, 2)

    # Values returned by the report must always be explicitly derived here.
    # Previously these names were returned without being defined, causing the
    # summary endpoint to fail and the mobile app to silently use local/cache data.
    cash_sales = round(sum(s.get("total", 0) for s in sales if not s.get("credit", False)), 2)
    cash_sale_returns = returns_total
    purchase_return_refunds = purchase_returns_total
    net_profit = round(gross_profit - personal_expenses, 2)
    opening_cash = opening_purchase_budget

    low_stock = [product_public(p).model_dump() for p in products
                 if p.get("quantity", 0) <= p.get("low_stock_threshold", 5)]
    inventory_value = round(sum(
        sum(float(layer.get("quantity", 0) or 0) * float(layer.get("unit_cost", 0) or 0) for layer in p.get("cost_layers", []))
        if p.get("cost_layers")
        else float(p.get("quantity", 0) or 0) * float(p.get("purchase_price", 0) or 0)
        for p in products
    ), 2)
    return {
        "range": range,
        "revenue": revenue,
        "gross_revenue": gross_revenue,
        "returns_total": returns_total,
        "returns_count": len(returns),
        "cogs_goods": cogs_goods,
        "cogs_expenses": cogs_expenses,
        "cogs_total": cogs_total,
        "personal_expenses": personal_expenses,
        "gross_profit": gross_profit,
        "operating_expenses": operating_expenses,
        "total_expenses": total_expenses,
        "supplier_payments": supplier_payments,
        "customer_receipts": customer_receipts,
        "supplier_refunds": supplier_refunds,
        "customer_refunds": customer_refunds,
        "cash_sales": cash_sales,
        "cash_sale_returns": round(cash_sale_returns, 2),
        "opening_cash": round(opening_cash, 2),
        "opening_purchase_budget": opening_purchase_budget,
        "monthly_expenses_budget": monthly_expenses_budget,
        "purchase_return_refunds": purchase_return_refunds,
        "net_profit": net_profit,
        "remaining_balance": remaining_balance,
        "units_sold": units_sold,
        "transactions": transactions,
        "purchase_total": purchase_net,
        "purchase_gross": purchase_total,
        "purchase_returns_total": purchase_returns_total,
        "inventory_value": inventory_value,
        "product_count": len(products),
        "low_stock": low_stock,
    }


@api.get("/reports/customers")
async def report_customers(_: Staff, range: str = "all", tz_offset_minutes: int = Query(0, ge=-840, le=840)):
    start = range_start(range, tz_offset_minutes)
    time_q = {"created_at": {"$gte": start.isoformat()}} if start else {}
    sales = await db.sales.find({**time_q, "deleted": {"$ne": True}}).to_list(20000)
    returns = await db.returns.find({**time_q, "deleted": {"$ne": True}}).to_list(20000)
    agg: dict = {}
    for s in sales:
        key = s.get("customer_id") or "walkin"
        name = s.get("customer_name", "Walk-in")
        row = agg.setdefault(key, {"customer_id": s.get("customer_id"), "name": name,
                                   "orders": 0, "total": 0.0, "units": 0.0})
        row["orders"] += 1
        row["total"] += s.get("total", 0)
        row["units"] += sum(i.get("quantity", 0) for i in s.get("items", []))
    for r in returns:
        key = r.get("customer_id") or "walkin"
        row = agg.get(key)
        if row:
            row["total"] -= r.get("refund_total", 0)
            row["units"] -= sum(i.get("quantity", 0) for i in r.get("items", []))
    rows = sorted(agg.values(), key=lambda r: r["total"], reverse=True)
    for r in rows:
        r["total"] = round(r["total"], 2)
    return rows


@api.get("/reports/day-close")
async def report_day_close(user: AnyUser, range: str = "today", tz_offset_minutes: int = Query(0, ge=-840, le=840)):
    start = range_start(range, tz_offset_minutes)
    time_q = {"created_at": {"$gte": start.isoformat()}} if start else {}
    sales = await db.sales.find({**time_q, "deleted": {"$ne": True}}).to_list(20000)

    def summarize(rows):
        gross = round(sum(s.get("total", 0) for s in rows), 2)
        discount = round(sum(s.get("discount", 0) for s in rows), 2)
        units = sum(sum(i.get("quantity", 0) for i in s.get("items", [])) for s in rows)
        return {"transactions": len(rows), "units": units, "gross_sales": gross, "discount": discount}

    mine = [s for s in sales if s.get("cashier_id") == oid(user["_id"])]
    me = {"user_name": user.get("name", user["email"]), "range": range, **summarize(mine)}

    by_user = None
    if user["role"] in ("admin", "partner"):
        groups: dict = {}
        for s in sales:
            key = s.get("cashier_id") or "?"
            groups.setdefault(key, {"user_name": s.get("cashier_name", "Unknown"), "rows": []})
            groups[key]["rows"].append(s)
        by_user = [
            {"user_name": g["user_name"], **summarize(g["rows"])}
            for g in sorted(groups.values(), key=lambda g: -sum(r.get("total", 0) for r in g["rows"]))
        ]

    return {"me": me, "by_user": by_user}


# ---------------------------------------------------------------------------
# Store settings (name + logo) — GET is public for the login screen
# ---------------------------------------------------------------------------
async def _settings_doc() -> dict:
    doc = await db.settings.find_one({"_id": "singleton"})
    return doc or {}


@api.get("/settings")
async def get_settings():
    doc = await _settings_doc()
    return {
        "store_name": doc.get("store_name", "Surgical Store"),
        "has_logo": bool(doc.get("logo_data") or doc.get("logo_path")),
        "logo_version": doc.get("logo_version", 0),
    }


@api.put("/settings")
async def update_settings(body: SettingsIn, _: AdminOnly):
    await db.settings.update_one(
        {"_id": "singleton"},
        {"$set": {"store_name": body.store_name.strip()}},
        upsert=True,
    )
    return await get_settings()


@api.post("/settings/logo")
async def upload_logo(_: AdminOnly, file: UploadFile = File(...)):
    # Store the logo in MongoDB so the app does not depend on external object storage.
    data = await file.read()
    if len(data) > 3 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Logo must be under 3 MB")
    ctype = file.content_type or "image/png"
    if ctype not in {"image/png", "image/jpeg", "image/jpg", "image/webp"}:
        raise HTTPException(status_code=400, detail="Unsupported logo format")
    doc = await _settings_doc()
    version = doc.get("logo_version", 0) + 1
    await db.settings.update_one(
        {"_id": "singleton"},
        {"$set": {"logo_data": Binary(data), "logo_content_type": ctype,
                  "logo_version": version, "logo_path": "__mongodb__"}},
        upsert=True,
    )
    return {"ok": True, "logo_version": version}

@api.get("/settings/logo")
async def get_logo():
    doc = await _settings_doc()
    data = doc.get("logo_data")
    if data is None:
        raise HTTPException(status_code=404, detail="No logo set")
    return Response(content=bytes(data), media_type=doc.get("logo_content_type", "image/png"),
                    headers={"Cache-Control": "no-cache"})

@api.get("/")
async def root():
    return {"app": "Surgical Store Manager", "status": "ok"}


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
