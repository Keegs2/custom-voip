"""Onboarding pipeline for new customer requests (product-aware intake).

This app stores the public signup form and tracks a lightweight status.
Billing accounts + provisioning are handled by an EXTERNAL system (integrated
later); "completed" is a STATUS-ONLY transition here — it does NOT create any
customer/user/RCF/DID records.

Workflow: pending → completed  (↘ rejected)

FCC Know-Your-Customer (KYC) capture — FCC 26-27 FNPRM (adopted 2026-04-30):
originating voice service providers must collect/verify/retain (4 years) for
ALL customers: legal name, physical address, government-issued identification
number, alternate telephone number; for HIGH-VOLUME customers additionally the
intended use of service and the originating IP address(es). The FNPRM directs
each provider to define its own high-volume threshold. GRANITE'S THRESHOLDS
(form_version fcc-26-27-fnprm-v2): more than 1 call per second (CPS), OR more
than 1,000 concurrent call paths — crossing EITHER makes the customer
high-volume. Every applicant declares `declared_peak_cps` and
`declared_max_concurrent_calls` on the KYC payload; the validator forces
`is_high_volume=true` (and the high_volume block) when either threshold is
exceeded. Voluntary opt-in below the thresholds remains allowed. Captured here
as the validated `kyc` payload on the public POST, persisted to
`onboarding_requests.kyc` JSONB (migration 35_onboarding_kyc.sql). Verification (gov-ID copies / formation records) and
the 4-year retention enforcement are ADMIN/OPERATIONAL steps, out of scope for
this intake endpoint — admins review the KYC data before completing a request.

Product-aware intake (products-v1): applicants select one or more products
(rcf / trunk / api / voicemail) and supply the setup information each selected
product needs to provision — RCF: DID count / porting / forwarding plan;
Trunk: PBX/SBC public signaling IPs (the platform is IP-peering only, no
REGISTER auth) + concurrent call paths; API: use case / CPS / webhook;
Voicemail: mailbox count + attachment target. Validated as the `products`
payload on the public POST, persisted to `onboarding_requests.products` JSONB
(migration 36_onboarding_products.sql). The legacy top-level RCF columns are
backfilled from products.rcf for backward compat.
"""
import ipaddress
import json
import logging
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
import re

from db import database as db
from auth.dependencies import require_admin
from utils.phone import normalize_e164

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

KYC_FORM_VERSION = "fcc-26-27-fnprm-v2"

# EIN: exactly NN-NNNNNNN (IRS employer identification number format).
_EIN_RE = re.compile(r"^\d{2}-\d{7}$")
_STATE_RE = re.compile(r"^[A-Za-z]{2}$")


def _validate_ip_or_cidr(entry: str) -> str:
    """Validate one originating-IP entry: bare IPv4/IPv6 address, or a CIDR
    block no larger than /24 (IPv4) / /64 (IPv6).

    Syntactic validity ONLY (per FCC 26-27 the provider records the addresses
    the customer declares) — private/reserved ranges are accepted and no
    reachability check is made. Returns the canonical string form.
    """
    entry = entry.strip()
    if "/" in entry:
        try:
            net = ipaddress.ip_network(entry, strict=False)
        except ValueError:
            raise ValueError(f"invalid CIDR block: '{entry}'")
        min_prefix = 24 if net.version == 4 else 64
        if net.prefixlen < min_prefix:
            raise ValueError(
                f"CIDR block too large: '{entry}' "
                f"(max /{min_prefix} for IPv{net.version})"
            )
        return str(net)
    try:
        return str(ipaddress.ip_address(entry))
    except ValueError:
        raise ValueError(f"invalid IP address: '{entry}'")


class KycStandard(BaseModel):
    """FCC 26-27 baseline KYC — required for ALL customers."""
    legal_business_name: str = Field(min_length=1, max_length=200)

    # Physical address (structured). Registered-agent / virtual-office
    # addresses are an FNPRM red flag — self-disclosed below.
    address_line1: str = Field(min_length=1, max_length=200)
    address_line2: Optional[str] = Field(default=None, max_length=200)
    city: str = Field(min_length=1, max_length=100)
    state: str
    postal_code: str = Field(min_length=3, max_length=20)
    address_is_registered_agent_or_virtual: bool

    # Government-issued identification number
    gov_id_type: Literal["ein", "state_registration", "duns", "other"]
    gov_id_number: str
    state_of_registration: Optional[str] = None  # required for state_registration

    alternate_phone: str  # E.164; must differ from the main contact phone
    website: Optional[str] = Field(default=None, max_length=255)

    @field_validator("legal_business_name", "address_line1", "city", "postal_code")
    @classmethod
    def strip_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip()

    @field_validator("state")
    @classmethod
    def validate_state(cls, v: str) -> str:
        v = v.strip()
        if not _STATE_RE.match(v):
            raise ValueError("state must be a 2-letter code")
        return v.upper()

    @field_validator("state_of_registration")
    @classmethod
    def validate_state_of_registration(cls, v: Optional[str]) -> Optional[str]:
        if v is None or not v.strip():
            return None
        v = v.strip()
        if not _STATE_RE.match(v):
            raise ValueError("state_of_registration must be a 2-letter code")
        return v.upper()

    @field_validator("alternate_phone")
    @classmethod
    def validate_alternate_phone(cls, v: str) -> str:
        try:
            return normalize_e164(v)
        except ValueError as e:
            raise ValueError(f"alternate_phone: {e}")

    @field_validator("website")
    @classmethod
    def validate_website(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() or None if v is not None else None

    @model_validator(mode="after")
    def validate_gov_id(self) -> "KycStandard":
        gov_id = self.gov_id_number.strip()
        if self.gov_id_type == "ein":
            if not _EIN_RE.match(gov_id):
                raise ValueError("gov_id_number: EIN must match NN-NNNNNNN")
        elif not (2 <= len(gov_id) <= 40):
            raise ValueError("gov_id_number must be 2-40 characters")
        self.gov_id_number = gov_id
        # Missing state registration is an FNPRM red flag — require the state
        # when the ID *is* a state registration; encourage (optional) otherwise.
        if self.gov_id_type == "state_registration" and not self.state_of_registration:
            raise ValueError(
                "state_of_registration is required when gov_id_type='state_registration'"
            )
        return self


class KycHighVolume(BaseModel):
    """FCC 26-27 additional KYC — required iff the customer is high-volume.

    Granite's provider-defined thresholds (FCC 26-27 directs each provider to
    set its own): >1 CPS or >1,000 concurrent call paths — either trips it.
    Enforced by KycPayload.validate_high_volume from the declared capacity
    fields; voluntary opt-in below the thresholds is still allowed.
    """
    intended_use: Literal[
        "marketing", "education", "political_campaign", "notifications_alerts",
        "customer_service", "ai_voice_agents", "other",
    ]
    intended_use_description: Optional[str] = Field(default=None, max_length=500)
    # IP address(es) from which calls will be placed. Syntactic validation only.
    originating_ips: list[str] = Field(min_length=1, max_length=20)
    expected_daily_calls: Optional[int] = Field(default=None, ge=0, le=10_000_000)

    @field_validator("originating_ips")
    @classmethod
    def validate_originating_ips(cls, v: list[str]) -> list[str]:
        return [_validate_ip_or_cidr(entry) for entry in v]

    @model_validator(mode="after")
    def validate_description(self) -> "KycHighVolume":
        desc = (self.intended_use_description or "").strip()
        self.intended_use_description = desc or None
        if self.intended_use == "other" and not desc:
            raise ValueError(
                "intended_use_description is required when intended_use='other'"
            )
        return self


class KycPayload(BaseModel):
    """The `kyc` object on the public intake POST. Stored in
    onboarding_requests.kyc as {standard, high_volume, declared_peak_cps,
    declared_max_concurrent_calls, submitted_at, form_version} — see
    35_onboarding_kyc.sql (capacity declarations ride in the JSONB; no
    migration needed)."""
    is_high_volume: bool
    standard: KycStandard
    high_volume: Optional[KycHighVolume] = None
    # Capacity declarations — REQUIRED; they drive Granite's provider-defined
    # high-volume threshold under FCC 26-27 (see validate_high_volume).
    declared_peak_cps: int = Field(
        ge=1, le=1000,
        description="The customer's expected peak calls per second",
    )
    declared_max_concurrent_calls: int = Field(
        ge=1, le=100_000,
        description="Expected peak simultaneous calls (call paths)",
    )

    @model_validator(mode="after")
    def validate_high_volume(self) -> "KycPayload":
        # Granite's high-volume thresholds (provider-defined per FCC 26-27):
        # crossing EITHER makes the customer high-volume.
        exceeds_threshold = (
            self.declared_peak_cps > 1
            or self.declared_max_concurrent_calls > 1000
        )
        if exceeds_threshold and not self.is_high_volume:
            raise ValueError(
                "is_high_volume must be true (with the high_volume block): "
                f"declared capacity (peak {self.declared_peak_cps} CPS, "
                f"{self.declared_max_concurrent_calls} concurrent call paths) "
                "exceeds Granite's high-volume threshold under the FCC's "
                "Know-Your-Customer rules (FCC 26-27) — more than 1 CPS or "
                "more than 1,000 concurrent call paths"
            )
        if self.is_high_volume and self.high_volume is None:
            raise ValueError(
                "high_volume KYC data is required when is_high_volume=true "
                "(FCC 26-27: intended use + originating IPs)"
            )
        if not self.is_high_volume and self.high_volume is not None:
            raise ValueError("high_volume must be null when is_high_volume=false")
        return self


PRODUCTS_FORM_VERSION = "products-v1"

# Option strings shared with the public form (RequestAccessSection.tsx).
# NOTE: DID counts use an EN dash (–); porting options use an EM dash (—).
DidCountOption = Literal["1–10", "11–50", "51–200", "201–1,000", "1,000+"]
PortingOption = Literal[
    "Yes — porting from another carrier",
    "No — need new numbers",
    "Both — porting some + new numbers",
]
ForwardingOption = Literal[
    "All numbers forward to one destination",
    "Each number forwards to a different destination",
    "Need help deciding",
]

ProductKey = Literal["rcf", "trunk", "api", "voicemail"]


class RcfIntake(BaseModel):
    """RCF setup info — mirrors the legacy top-level intake fields."""
    did_count: DidCountOption
    porting: PortingOption
    current_carrier: Optional[str] = Field(default=None, max_length=200)
    forwarding_setup: ForwardingOption

    @model_validator(mode="after")
    def validate_carrier_required_when_porting(self) -> "RcfIntake":
        carrier = (self.current_carrier or "").strip()
        self.current_carrier = carrier or None
        if self.porting.startswith(("Yes", "Both")) and not carrier:
            raise ValueError(
                "current_carrier is required when porting existing numbers"
            )
        return self


class TrunkIntake(BaseModel):
    """SIP Trunking setup info. The platform is IP-peering ONLY (REGISTER
    auth is declined), so the PBX/SBC public signaling IPs are REQUIRED to
    provision a trunk — same syntactic IP/CIDR validation as KYC."""
    signaling_ips: list[str] = Field(min_length=1, max_length=10)
    concurrent_call_paths: int = Field(ge=1, le=1000)
    pbx_vendor: Optional[str] = Field(default=None, max_length=100)
    dids_needed: Optional[str] = Field(default=None, max_length=200)

    @field_validator("signaling_ips")
    @classmethod
    def validate_signaling_ips(cls, v: list[str]) -> list[str]:
        return [_validate_ip_or_cidr(entry) for entry in v]

    @field_validator("pbx_vendor", "dids_needed")
    @classmethod
    def strip_optional(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() or None if v is not None else None


class ApiIntake(BaseModel):
    """API Calling setup info."""
    use_case: str = Field(min_length=1, max_length=300)
    expected_cps: Optional[int] = Field(default=None, ge=1, le=1000)
    webhook_url: Optional[str] = Field(default=None, max_length=255)
    needs_numbers: bool

    @field_validator("use_case")
    @classmethod
    def strip_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip()

    @field_validator("webhook_url")
    @classmethod
    def validate_webhook_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None or not v.strip():
            return None
        v = v.strip()
        # Basic validation only: http(s) scheme + a plausible host part.
        if not re.match(r"^https?://[A-Za-z0-9.-]+(:\d+)?(/\S*)?$", v):
            raise ValueError("webhook_url must be a valid http(s):// URL")
        return v


class VoicemailIntake(BaseModel):
    """Visual Voicemail setup info."""
    mailbox_count: int = Field(ge=1, le=10_000)
    attach_to: Literal["existing_numbers", "new_numbers", "unsure"]


class ProductsPayload(BaseModel):
    """The `products` object on the public intake POST. Each product block
    must be present iff the product is selected. Stored in
    onboarding_requests.products as the validated payload + form_version —
    see 36_onboarding_products.sql."""
    selected: list[ProductKey] = Field(min_length=1)
    rcf: Optional[RcfIntake] = None
    trunk: Optional[TrunkIntake] = None
    api: Optional[ApiIntake] = None
    voicemail: Optional[VoicemailIntake] = None

    @field_validator("selected")
    @classmethod
    def validate_no_duplicates(cls, v: list[str]) -> list[str]:
        if len(v) != len(set(v)):
            raise ValueError("selected must not contain duplicates")
        return v

    @model_validator(mode="after")
    def validate_blocks_match_selection(self) -> "ProductsPayload":
        for key in ("rcf", "trunk", "api", "voicemail"):
            block = getattr(self, key)
            if key in self.selected and block is None:
                raise ValueError(
                    f"products.{key} is required when '{key}' is selected"
                )
            if key not in self.selected and block is not None:
                raise ValueError(
                    f"products.{key} must be null when '{key}' is not selected"
                )
        return self


class OnboardingSubmit(BaseModel):
    company_name: str
    contact_name: str
    email: str
    phone: str
    # Legacy top-level RCF fields — the product-aware form sends the RCF info
    # inside products.rcf instead. Accepted if present (the frontend mirrors
    # products.rcf into them for backward compat) but no longer required.
    did_count: Optional[str] = None
    porting: Optional[str] = None
    current_carrier: Optional[str] = None
    forwarding_setup: Optional[str] = None
    monthly_volume: str
    timeline: str
    # FCC 26-27 KYC — REQUIRED on all new submissions (pre-KYC DB rows stay
    # NULL; the column is nullable).
    kyc: KycPayload
    # Product selection + per-product setup info — REQUIRED on all new
    # submissions (pre-products DB rows stay NULL; the column is nullable).
    products: ProductsPayload

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        if not re.match(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$", v):
            raise ValueError("Invalid email address")
        return v.lower().strip()

    @field_validator("company_name", "contact_name", "phone",
                     "monthly_volume", "timeline")
    @classmethod
    def validate_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Field cannot be empty")
        return v.strip()

    @field_validator("did_count", "porting", "current_carrier",
                     "forwarding_setup")
    @classmethod
    def strip_optional_legacy(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() or None if v is not None else None

    @model_validator(mode="after")
    def validate_alternate_phone_differs(self) -> "OnboardingSubmit":
        """FCC 26-27: the alternate phone must be a genuinely different number
        from the main contact phone. Compare in canonical E.164 where possible;
        the legacy free-text `phone` may not normalize, so fall back to a
        digits-only comparison."""
        alt = self.kyc.standard.alternate_phone  # already canonical E.164
        try:
            main = normalize_e164(self.phone)
        except ValueError:
            main = re.sub(r"\D", "", self.phone)
            alt = re.sub(r"\D", "", alt)
        if main == alt:
            raise ValueError(
                "kyc.standard.alternate_phone must differ from the main phone"
            )
        return self

    # NOTE (fcc-26-27-fnprm-v2): the legacy 50,000+ calls/month high-volume
    # rule was REPLACED by Granite's capacity thresholds (>1 CPS or >1,000
    # concurrent call paths), enforced in KycPayload.validate_high_volume from
    # the declared_peak_cps / declared_max_concurrent_calls fields.
    # monthly_volume remains informational only.


class CompleteRequest(BaseModel):
    notes: Optional[str] = None


class RejectRequest(BaseModel):
    reason: Optional[str] = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

def _decode_json_col(item: dict, *cols: str) -> dict:
    """asyncpg returns JSONB as a JSON string (no type codec registered) —
    decode the given columns in place so admin responses carry structured
    objects. Tolerant: a malformed row returns the raw string rather than 500;
    NULL columns stay None (legacy rows)."""
    for col in cols:
        if isinstance(item.get(col), str):
            try:
                item[col] = json.loads(item[col])
            except (ValueError, TypeError):
                pass
    return item


@router.post("")
async def submit_onboarding_request(body: OnboardingSubmit):
    """Submit a new onboarding request. Public endpoint (no auth required).

    Persists the FCC 26-27 KYC payload alongside the intake form:
    {standard, high_volume|null, declared_peak_cps,
    declared_max_concurrent_calls, submitted_at, form_version}. Retained
    4 years (operational policy) per FCC 26-27.

    Persists the product selection + per-product setup info to `products`
    JSONB (36_onboarding_products.sql): the validated ProductsPayload +
    form_version. The legacy top-level RCF columns (did_count, porting,
    current_carrier, forwarding_setup) are backfilled from products.rcf when
    absent, so pre-products admin queries stay meaningful; non-RCF
    submissions insert NULLs there.
    """
    kyc_doc = {
        "standard": body.kyc.standard.model_dump(),
        "high_volume": (
            body.kyc.high_volume.model_dump() if body.kyc.high_volume else None
        ),
        # Capacity declarations driving Granite's high-volume threshold
        # (>1 CPS or >1,000 concurrent call paths) under FCC 26-27.
        "declared_peak_cps": body.kyc.declared_peak_cps,
        "declared_max_concurrent_calls": body.kyc.declared_max_concurrent_calls,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "form_version": KYC_FORM_VERSION,
    }
    products_doc = body.products.model_dump()
    products_doc["form_version"] = PRODUCTS_FORM_VERSION

    # Legacy-column backfill: prefer the mirrored top-level fields if the
    # frontend sent them, else fall back to products.rcf, else NULL.
    rcf = body.products.rcf
    did_count = body.did_count or (rcf.did_count if rcf else None)
    porting = body.porting or (rcf.porting if rcf else None)
    current_carrier = body.current_carrier or (rcf.current_carrier if rcf else None)
    forwarding_setup = body.forwarding_setup or (rcf.forwarding_setup if rcf else None)

    result = await db.fetch_one(
        """
        INSERT INTO onboarding_requests
            (company_name, contact_name, email, phone, did_count, porting,
             current_carrier, forwarding_setup, monthly_volume, timeline, kyc,
             products)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                $12::jsonb)
        RETURNING id, status, created_at
        """,
        body.company_name, body.contact_name, body.email, body.phone,
        did_count, porting, current_carrier,
        forwarding_setup, body.monthly_volume, body.timeline,
        json.dumps(kyc_doc), json.dumps(products_doc),
    )
    logger.info("Onboarding request submitted: id=%d, company=%s, email=%s, products=%s",
                result["id"], body.company_name, body.email,
                ",".join(body.products.selected))
    return dict(result)


@router.get("")
async def list_onboarding_requests(
    admin: dict = Depends(require_admin),
    status: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    """List onboarding requests with optional status filter. Admin only."""
    query = """
        SELECT o.*,
               rv.name AS reviewed_by_name,
               cb.name AS completed_by_name,
               COUNT(*) OVER() AS total_count
          FROM onboarding_requests o
          LEFT JOIN users rv ON o.reviewed_by = rv.id
          LEFT JOIN users cb ON o.completed_by = cb.id
         WHERE 1=1
    """
    values: list = []
    idx = 1

    if status is not None:
        query += f" AND o.status = ${idx}"
        values.append(status)
        idx += 1

    query += f" ORDER BY o.created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    total = rows[0]["total_count"] if rows else 0

    items = []
    for r in rows:
        item = _decode_json_col(dict(r), "kyc", "products")
        item.pop("total_count", None)
        items.append(item)

    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/{request_id}")
async def get_onboarding_request(
    request_id: int,
    admin: dict = Depends(require_admin),
):
    """Get a single onboarding request with full details. Admin only."""
    result = await db.fetch_one(
        """
        SELECT o.*,
               rv.name AS reviewed_by_name,
               cb.name AS completed_by_name
          FROM onboarding_requests o
          LEFT JOIN users rv ON o.reviewed_by = rv.id
          LEFT JOIN users cb ON o.completed_by = cb.id
         WHERE o.id = $1
        """,
        request_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Onboarding request not found")
    return _decode_json_col(dict(result), "kyc", "products")


@router.post("/{request_id}/complete")
async def complete_onboarding(
    request_id: int,
    body: CompleteRequest,
    admin: dict = Depends(require_admin),
):
    """Mark an onboarding request complete. Requires status='pending'. Admin only.

    Status-only transition: does NOT create any customer/user/RCF/DID records
    (billing + provisioning are handled by an external system).
    """
    admin_id = int(admin["sub"])

    existing = await db.fetch_one(
        "SELECT id, status FROM onboarding_requests WHERE id = $1",
        request_id,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Onboarding request not found")
    if existing["status"] != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Cannot complete: request is '{existing['status']}', expected 'pending'",
        )

    now = datetime.now(timezone.utc)
    result = await db.fetch_one(
        """
        UPDATE onboarding_requests
           SET status = 'completed',
               completed_by = $1::int,
               completed_at = $2::timestamptz,
               admin_notes = $3,
               updated_at = $2::timestamptz
         WHERE id = $4::int
         RETURNING id, status, completed_at
        """,
        admin_id, now, body.notes, request_id,
    )
    logger.info("Onboarding completed: request=%d, by_admin=%d", request_id, admin_id)
    return dict(result)


@router.post("/{request_id}/reject")
async def reject_onboarding(
    request_id: int,
    body: RejectRequest,
    admin: dict = Depends(require_admin),
):
    """Reject an onboarding request. Admin only."""
    admin_id = int(admin["sub"])

    existing = await db.fetch_one(
        "SELECT id, status FROM onboarding_requests WHERE id = $1",
        request_id,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Onboarding request not found")
    if existing["status"] in ("completed", "rejected"):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot reject: request is already '{existing['status']}'",
        )

    now = datetime.now(timezone.utc)
    result = await db.fetch_one(
        """
        UPDATE onboarding_requests
           SET status = 'rejected',
               rejected_by = $1,
               rejected_at = $2,
               rejection_reason = $3,
               updated_at = $2
         WHERE id = $4
         RETURNING id, status
        """,
        admin_id, now, body.reason, request_id,
    )
    logger.info("Onboarding rejected: request=%d, by_admin=%d", request_id, admin_id)
    return dict(result)
