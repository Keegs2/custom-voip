"""
FreeSWITCH ESL (Event Socket) Client
For originating calls and controlling live calls from the API
"""
import os
import asyncio
import logging
from typing import Optional, Dict

logger = logging.getLogger(__name__)

# ESL connection settings
# FS runs with host networking — API container reaches it via Docker gateway
ESL_HOST = os.getenv("FREESWITCH_ESL_HOST", "172.28.0.1")
ESL_PORT = int(os.getenv("FREESWITCH_ESL_PORT", "8021"))
ESL_PASSWORD = os.getenv("FREESWITCH_ESL_PASSWORD", "ClueCon")


async def _send_esl_command(command: str) -> Optional[str]:
    """Send a command to FreeSWITCH via ESL."""
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ESL_HOST, ESL_PORT),
            timeout=5.0
        )

        # Read auth request
        data = await asyncio.wait_for(reader.read(1024), timeout=5.0)
        if b"auth/request" not in data:
            logger.error(f"Unexpected ESL response: {data}")
            writer.close()
            return None

        # Authenticate
        writer.write(f"auth {ESL_PASSWORD}\n\n".encode())
        await writer.drain()

        # Read auth response
        data = await asyncio.wait_for(reader.read(1024), timeout=5.0)
        if b"+OK" not in data:
            logger.error(f"ESL auth failed: {data}")
            writer.close()
            return None

        # Send command
        writer.write(f"api {command}\n\n".encode())
        await writer.drain()

        # Read response
        response = b""
        while True:
            chunk = await asyncio.wait_for(reader.read(4096), timeout=10.0)
            if not chunk:
                break
            response += chunk
            if b"\n\n" in chunk:
                break

        writer.close()
        await writer.wait_closed()

        return response.decode()

    except asyncio.TimeoutError:
        logger.error("ESL connection timeout")
        return None
    except Exception as e:
        logger.error(f"ESL error: {e}")
        return None


async def originate_call(
    uuid: str,
    from_did: str,
    to: str,
    customer_id: int,
    traffic_grade: str = "standard",
    webhook_url: str = "",
    timeout: int = 60
) -> bool:
    """Originate an outbound call."""
    # Build originate command
    # Format: originate {vars}sofia/external/destination@proxy &lua(script.lua)
    # Uses external profile through Kamailio proxy to ensure ext-sip-ip (public IP)
    # appears in Via, Contact, and SDP headers on outbound INVITEs.
    # The internal profile does NOT apply ext-sip-ip to outbound calls.
    # Determine carrier for X-Carrier header (Kamailio routes to correct Bandwidth IP)
    carrier = "premium" if traffic_grade == "premium" else "standard"

    vars_str = ",".join([
        f"origination_uuid={uuid}",
        f"origination_caller_id_number={from_did}",
        f"customer_id={customer_id}",
        f"product_type=api",
        f"direction=outbound",
        f"traffic_grade={traffic_grade}",
        f"outbound_api=true",
        f"webhook_url={webhook_url}",
        f"ignore_early_media=true",
        f"originate_timeout={timeout}",
        f"sip_h_X-Carrier={carrier}"
    ])

    # For testing without carrier, use loopback
    if os.getenv("TEST_MODE") == "true":
        command = f"originate {{{vars_str}}}loopback/{to}/default &lua(outbound_api.lua)"
    else:
        # Use sofia/external/dest@proxy to ensure the outbound INVITE uses
        # ext-sip-ip (public IP) in Via, Contact, and SDP headers.
        # X-Carrier header tells Kamailio which Bandwidth IP to route to.
        command = f"originate {{{vars_str}}}sofia/external/{to}@172.28.0.1:5060 &lua(outbound_api.lua)"

    logger.info(f"Originating call: {uuid} to {to}")
    response = await _send_esl_command(command)

    if response and "+OK" in response:
        logger.info(f"Call originated successfully: {uuid}")
        return True
    else:
        logger.error(f"Call origination failed: {response}")
        return False


async def get_call_status(call_id: str) -> Dict:
    """Get the current status of a call."""
    command = f"uuid_dump {call_id}"
    response = await _send_esl_command(command)

    if not response or "-ERR" in response:
        return {"state": "not_found"}

    # Parse response into dict
    status = {"state": "active"}
    for line in response.split("\n"):
        if ":" in line:
            key, value = line.split(":", 1)
            key = key.strip().lower()
            value = value.strip()

            if key == "channel_state":
                status["state"] = value.lower()
            elif key == "answer_state":
                status["answer_state"] = value.lower()

    return status


async def hangup_call(call_id: str, cause: str = "NORMAL_CLEARING") -> bool:
    """Hangup a call by UUID."""
    command = f"uuid_kill {call_id} {cause}"
    response = await _send_esl_command(command)

    if response and "+OK" in response:
        logger.info(f"Call hung up: {call_id}")
        return True
    return False


async def transfer_call(call_id: str, destination: str) -> bool:
    """Transfer a call to a new destination."""
    command = f"uuid_transfer {call_id} {destination}"
    response = await _send_esl_command(command)
    return response is not None and "+OK" in response


async def send_dtmf(call_id: str, digits: str) -> bool:
    """Send DTMF digits to a call."""
    command = f"uuid_send_dtmf {call_id} {digits}"
    response = await _send_esl_command(command)
    return response is not None and "+OK" in response
