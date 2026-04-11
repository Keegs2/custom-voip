"""FreeSWITCH mod_xml_curl directory endpoint.

Serves dynamic user directory XML so FreeSWITCH can resolve extensions
per-customer (multi-tenant namespacing).

Domain convention:
    customer_{customer_id}.voiceplatform.local
    e.g., customer_5.voiceplatform.local  =>  customer_id = 5

FreeSWITCH POSTs form-encoded parameters on every REGISTER and INVITE
that touches the directory.  Key parameters:
    section   = "directory"
    action    = "sip_auth" | "user_call" | "message-count" | ...
    user      = extension number (e.g., "100")
    domain    = SIP domain (e.g., "customer_5.voiceplatform.local")

Performance: Results are cached in Redis for 30 seconds to avoid hitting
PostgreSQL on every registration refresh cycle.
"""

import re
import logging
from fastapi import APIRouter, Request, Form
from fastapi.responses import Response

from db import database as db
from db.redis_client import cache_get, cache_set

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Domain pattern: customer_{id}.voiceplatform.local
_DOMAIN_RE = re.compile(r"^customer_(\d+)\.voiceplatform\.local$")

# Cache TTL in seconds.  30s is short enough that password changes propagate
# quickly, but long enough to absorb REGISTER storms (FS re-registers every
# 60-120s per user, and each REGISTER triggers 2 directory lookups: one for
# the challenge, one for the auth check).
_CACHE_TTL = 30

# The legacy domain used by static directory entries (test extensions 1001-1003).
# If a request arrives for this domain, we let FS fall through to static XML.
_LEGACY_DOMAIN = "voiceplatform.local"

# XML templates -----------------------------------------------------------------

_NOT_FOUND_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    "<document type=\"freeswitch/xml\">\n"
    '  <section name="directory"/>\n'
    "</document>\n"
)

_USER_XML_TEMPLATE = """\
<?xml version="1.0" encoding="UTF-8"?>
<document type="freeswitch/xml">
  <section name="directory">
    <domain name="{domain}">
      <params>
        <param name="dial-string" value="{{presence_id=${{dialed_user}}@${{dialed_domain}}}}${{sofia_contact(*/${{dialed_user}}@${{dialed_domain}})}}"/>
        <param name="parse" value="true"/>
      </params>
      <user id="{extension}">
        <params>
          <param name="password" value="{password}"/>
          <param name="vm-enabled" value="{vm_enabled}"/>
          <param name="jsonrpc-allowed-methods" value="verto"/>
          <param name="jsonrpc-allowed-event-channels" value="demo,conference,presence"/>
        </params>
        <variables>
          <variable name="user_context" value="default"/>
          <variable name="effective_caller_id_name" value="{display_name}"/>
          <variable name="effective_caller_id_number" value="{extension}"/>
          <variable name="accountcode" value="{extension}"/>
          <variable name="toll_allow" value="domestic,international,local"/>
          <variable name="customer_id" value="{customer_id}"/>
          <variable name="customer_domain" value="{domain}"/>
          <variable name="outbound_caller_id_name" value="{display_name}"/>
          <variable name="outbound_caller_id_number" value="{outbound_caller_id}"/>
        </variables>
      </user>
    </domain>
  </section>
</document>
"""


def _xml_escape(value: str) -> str:
    """Escape XML special characters in user-supplied values."""
    return (
        value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/directory")
async def freeswitch_directory(request: Request):
    """Handle mod_xml_curl directory lookups from FreeSWITCH.

    FreeSWITCH sends form-encoded POST data.  We parse the key fields,
    look up the extension in the database (with Redis caching), and return
    XML that FreeSWITCH can consume for user authentication and call routing.

    If the extension or domain is not found, we return an empty <section/>
    which tells FreeSWITCH to fall through to the next binding (static XML).
    """
    # Parse the form body
    form = await request.form()
    section = form.get("section", "")
    action = form.get("action", "")
    user = form.get("user", "")
    domain = form.get("domain", "")

    logger.debug(
        "xml_curl directory request: section=%s action=%s user=%s domain=%s",
        section, action, user, domain,
    )

    # Only handle directory section requests
    if section != "directory":
        return Response(content=_NOT_FOUND_XML, media_type="text/xml")

    # Let the legacy domain fall through to static XML (test exts 1001-1003)
    if domain == _LEGACY_DOMAIN or not domain:
        return Response(content=_NOT_FOUND_XML, media_type="text/xml")

    # Extract customer_id from domain
    match = _DOMAIN_RE.match(domain)
    if not match:
        logger.warning(
            "xml_curl: unrecognized domain format: %s (user=%s)", domain, user,
        )
        return Response(content=_NOT_FOUND_XML, media_type="text/xml")

    customer_id = int(match.group(1))

    if not user:
        return Response(content=_NOT_FOUND_XML, media_type="text/xml")

    # ------------------------------------------------------------------
    # Redis cache check
    # ------------------------------------------------------------------
    cache_key = f"fs_dir:{customer_id}:{user}"
    cached = await cache_get(cache_key)
    if cached is not None:
        if cached == "__NOT_FOUND__":
            return Response(content=_NOT_FOUND_XML, media_type="text/xml")
        return Response(content=cached, media_type="text/xml")

    # ------------------------------------------------------------------
    # Database lookup
    # ------------------------------------------------------------------
    row = await db.fetch_one(
        """SELECT e.extension, e.voicemail_pin, e.sip_password,
                  e.display_name, e.voicemail_enabled, e.assigned_did,
                  e.status, c.name AS customer_name
           FROM extensions e
           JOIN customers c ON e.customer_id = c.id
           WHERE e.extension = $1
             AND e.customer_id = $2
             AND e.status = 'active'
             AND c.status = 'active'""",
        user,
        customer_id,
    )

    if not row:
        logger.debug(
            "xml_curl: extension not found: user=%s customer_id=%d", user, customer_id,
        )
        # Cache the miss to avoid repeated DB queries for non-existent users
        # (e.g., SIP scanners probing random extensions)
        await cache_set(cache_key, "__NOT_FOUND__", _CACHE_TTL)
        return Response(content=_NOT_FOUND_XML, media_type="text/xml")

    ext = dict(row)

    # Build the response XML
    # Prefer dedicated sip_password; fall back to voicemail_pin for
    # backward compatibility with existing deployments.
    password = ext.get("sip_password") or ext.get("voicemail_pin") or "1234"
    display_name = ext.get("display_name") or f"Ext {user}"
    vm_enabled = "true" if ext.get("voicemail_enabled") else "false"
    outbound_cid = ext.get("assigned_did") or ""

    xml_body = _USER_XML_TEMPLATE.format(
        domain=_xml_escape(domain),
        extension=_xml_escape(user),
        password=_xml_escape(password),
        vm_enabled=vm_enabled,
        display_name=_xml_escape(display_name),
        customer_id=customer_id,
        outbound_caller_id=_xml_escape(outbound_cid),
    )

    # Cache the successful result
    await cache_set(cache_key, xml_body, _CACHE_TTL)

    logger.info(
        "xml_curl: served directory for user=%s domain=%s action=%s",
        user, domain, action,
    )

    return Response(content=xml_body, media_type="text/xml")
