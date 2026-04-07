"""
Test Webhook Server
Simulates customer webhook endpoint for API calling tests.
Returns TwiML-compatible XML responses to drive FreeSWITCH call control
via the voice_webhook.lua engine.

Endpoints:
    /health              - Health check
    /voice               - Main voice webhook (IVR menu)
    /voice/handle-key    - Handle DTMF input from Gather
    /status              - Receive call status callbacks
    /fallback            - Fallback handler when primary webhook fails
"""
from flask import Flask, request, Response
import json
import logging
from datetime import datetime

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def xml_response(xml_body):
    """Return a properly formatted XML response with correct content type."""
    full_xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xml_body
    return Response(full_xml, mimetype='application/xml')


def log_request(endpoint):
    """Log incoming webhook request details."""
    logger.info(f"[{endpoint}] {request.method} from {request.remote_addr}")
    if request.is_json:
        data = request.get_json()
        logger.info(f"[{endpoint}] JSON data: {json.dumps(data, indent=2)}")
    elif request.form:
        logger.info(f"[{endpoint}] Form data: {dict(request.form)}")
    elif request.data:
        logger.info(f"[{endpoint}] Raw data: {request.data.decode('utf-8', errors='replace')[:500]}")


@app.route('/health')
def health():
    return {'status': 'ok'}


@app.route('/voice', methods=['GET', 'POST'])
def voice_webhook():
    """
    Main voice webhook - returns an IVR menu with Gather.
    This is the primary entry point for inbound API DID calls.

    The voice_webhook.lua engine POSTs here with:
        CallSid, AccountSid, From, To, CallStatus, Direction
    """
    log_request('/voice')

    call_sid = request.values.get('CallSid', 'unknown')
    caller_id = request.values.get('From', 'unknown')
    destination = request.values.get('To', 'unknown')
    direction = request.values.get('Direction', 'inbound')
    call_status = request.values.get('CallStatus', 'unknown')

    logger.info(
        f"[/voice] Call: sid={call_sid} from={caller_id} to={destination} "
        f"dir={direction} status={call_status}"
    )

    return xml_response(
        '<Response>\n'
        '    <Say>Welcome to the Custom VoIP test line.</Say>\n'
        '    <Gather numDigits="1" action="/voice/handle-key" timeout="5">\n'
        '        <Say>Press 1 for a test message. Press 2 to be connected to the echo test. Press 9 to hang up.</Say>\n'
        '    </Gather>\n'
        '    <Say>We did not receive any input. Goodbye.</Say>\n'
        '    <Hangup/>\n'
        '</Response>'
    )


@app.route('/voice/handle-key', methods=['GET', 'POST'])
def handle_key():
    """
    Handle DTMF input from Gather verb.

    The voice_webhook.lua engine POSTs here with:
        CallSid, AccountSid, From, To, CallStatus, Direction, Digits
    """
    log_request('/voice/handle-key')

    digit = request.values.get('Digits', '')
    call_sid = request.values.get('CallSid', 'unknown')

    logger.info(f"[/voice/handle-key] Call {call_sid}: Digits='{digit}'")

    if digit == '1':
        return xml_response(
            '<Response>\n'
            '    <Say>This is a test message from the Custom VoIP platform. '
            'The webhook integration is working correctly.</Say>\n'
            '    <Hangup/>\n'
            '</Response>'
        )

    elif digit == '2':
        return xml_response(
            '<Response>\n'
            '    <Say>Connecting you to the echo test.</Say>\n'
            '    <Dial>9196</Dial>\n'
            '</Response>'
        )

    elif digit == '9':
        return xml_response(
            '<Response>\n'
            '    <Say>Goodbye.</Say>\n'
            '    <Hangup/>\n'
            '</Response>'
        )

    else:
        logger.info(f"[/voice/handle-key] Invalid digit '{digit}', redirecting to /voice")
        return xml_response(
            '<Response>\n'
            '    <Say>Invalid selection.</Say>\n'
            '    <Redirect>/voice</Redirect>\n'
            '</Response>'
        )


@app.route('/status', methods=['GET', 'POST'])
def status_callback():
    """
    Handle call status callbacks from voice_webhook.lua.

    Receives:
        CallSid, AccountSid, From, To, CallStatus, Direction,
        Duration, CallDuration, HangupCause
    """
    log_request('/status')

    # Extract status data from either JSON or form-encoded body
    if request.is_json:
        data = request.get_json()
    else:
        data = dict(request.form)

    call_sid = data.get('CallSid', 'unknown')
    call_status = data.get('CallStatus', 'unknown')
    duration = data.get('Duration', '0')
    hangup_cause = data.get('HangupCause', 'unknown')
    direction = data.get('Direction', 'unknown')
    from_number = data.get('From', 'unknown')
    to_number = data.get('To', 'unknown')

    logger.info(
        f"[/status] Call ended: sid={call_sid} status={call_status} "
        f"duration={duration}s cause={hangup_cause} dir={direction} "
        f"from={from_number} to={to_number}"
    )

    # Store status for test verification
    try:
        with open('/tmp/call_status.log', 'a') as f:
            f.write(f"{datetime.now().isoformat()} | {json.dumps(data)}\n")
    except Exception as e:
        logger.warning(f"[/status] Failed to write status log: {e}")

    return Response(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Response/>',
        status=200,
        mimetype='application/xml'
    )


@app.route('/fallback', methods=['GET', 'POST'])
def fallback():
    """Fallback handler when primary webhook fails."""
    log_request('/fallback')
    logger.warning("[/fallback] Fallback webhook called - primary webhook may be failing")

    return xml_response(
        '<Response>\n'
        '    <Say>We are experiencing technical difficulties. Please try again later.</Say>\n'
        '    <Hangup/>\n'
        '</Response>'
    )


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=9000, debug=True)
