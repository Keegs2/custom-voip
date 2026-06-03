"""FreeSWITCH mod_xml_curl gateway endpoints.

FreeSWITCH's mod_xml_curl POSTs to the API whenever it needs a dynamic XML
document for a binding (directory, dialplan, configuration, ...). The gateway
URL is configured in `docker/freeswitch/conf/autoload_configs/xml_curl.conf.xml`
(currently `http://$${api_host}:$${api_port}/freeswitch/directory`, bound to the
`directory` section).

CARRIER-GRADE CONTRACT — never return a bare HTTP 404 to mod_xml_curl.

When mod_xml_curl receives any HTTP status other than 200, it logs:

    [ERR] mod_xml_curl.c:319 Received HTTP error 404 trying to fetch
          http://<api>/freeswitch/directory

That ERROR is emitted on EVERY inbound call (the directory binding fires during
INVITE handling), producing per-call ERR spam in the FreeSWITCH logs.

The correct way to tell FreeSWITCH "I have no dynamic entry, use your local
static config" is to return HTTP 200 with the canonical FreeSWITCH
"not found" XML document:

    <document type="freeswitch/xml">
      <section name="result">
        <result status="not found"/>
      </section>
    </document>

mod_xml_curl treats this as a clean "no dynamic match" and silently falls back
to the static XML (e.g. directory/default.xml) with NO error logged.

RCF-V1 serves no dynamic directory/dialplan/configuration entries (RCF routing
is done in Lua via PostgreSQL, not via xml_curl). So every section returns the
not-found document. This module is written so that if dynamic responses are
added later, they slot in per-section while the fallback guarantees that a
well-formed request can never produce a bare 404.

Auth: these paths are exempt from JWT in `middleware/auth.py`
(`path.startswith("/freeswitch/")`). FreeSWITCH calls them unauthenticated over
the internal network.
"""
import logging

from fastapi import APIRouter, Request, Response

logger = logging.getLogger(__name__)

router = APIRouter()

# Canonical FreeSWITCH "not found" document. Returning this with HTTP 200 tells
# mod_xml_curl to fall back to static local config WITHOUT logging an HTTP error.
FS_NOT_FOUND_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    '<document type="freeswitch/xml">\n'
    '  <section name="result">\n'
    '    <result status="not found"/>\n'
    '  </section>\n'
    '</document>\n'
)

# mod_xml_curl expects text/xml. (It parses the body regardless of header, but a
# correct Content-Type avoids any proxy/middleware re-interpretation.)
_XML_MEDIA_TYPE = "text/xml; charset=utf-8"


def _not_found_response() -> Response:
    """Return the canonical FS not-found document with HTTP 200 + text/xml."""
    return Response(
        content=FS_NOT_FOUND_XML,
        status_code=200,
        media_type=_XML_MEDIA_TYPE,
    )


async def _log_binding(request: Request, section: str) -> None:
    """Best-effort debug log of what FreeSWITCH asked for (never raises)."""
    try:
        # mod_xml_curl POSTs the binding params as form-encoded fields
        # (section, tag_name, key_name, key_value, hostname, ...). We only
        # read them for debugging; the response is always not-found in RCF-V1.
        form = await request.form()
        params = {k: v for k, v in form.items()}
        logger.debug(
            "xml_curl request: section=%s params=%s", section, params,
        )
    except Exception:  # noqa: BLE001 - logging must never break the response
        logger.debug("xml_curl request: section=%s (could not parse form)", section)


# Explicit per-section routes. RCF-V1 serves no dynamic entries, so each returns
# the canonical not-found document with HTTP 200 (never a bare 404). If dynamic
# provisioning is added later (e.g. UCaaS directory on Full-System), build the
# real document here and fall back to _not_found_response() when there is no
# match — the contract (HTTP 200, never 404) stays intact.

@router.post("/directory")
@router.get("/directory")
async def freeswitch_directory(request: Request) -> Response:
    """Directory binding (user auth / `user/` dial-string resolution).

    RCF-V1 has no dynamic directory entries — always returns the not-found
    document so FreeSWITCH uses its static directory (directory/default.xml).
    """
    await _log_binding(request, "directory")
    return _not_found_response()


@router.post("/dialplan")
@router.get("/dialplan")
async def freeswitch_dialplan(request: Request) -> Response:
    """Dialplan binding. RCF-V1 uses static dialplan XML (public.xml); no
    dynamic dialplan is served. Returns not-found so FS uses local config."""
    await _log_binding(request, "dialplan")
    return _not_found_response()


@router.post("/configuration")
@router.get("/configuration")
async def freeswitch_configuration(request: Request) -> Response:
    """Configuration binding. RCF-V1 serves no dynamic module config via
    xml_curl. Returns not-found so FS uses its local autoload_configs."""
    await _log_binding(request, "configuration")
    return _not_found_response()


# Catch-all: any other section FreeSWITCH binds (languages, phrases, ...) must
# also get HTTP 200 + not-found, never a bare 404. Defense in depth — this
# guarantees zero per-call ERR spam regardless of FreeSWITCH binding config.
@router.post("/{section}")
@router.get("/{section}")
async def freeswitch_catch_all(section: str, request: Request) -> Response:
    """Fallback for any unmodeled xml_curl section. Always HTTP 200 +
    not-found so mod_xml_curl never logs an HTTP error."""
    await _log_binding(request, section)
    return _not_found_response()
