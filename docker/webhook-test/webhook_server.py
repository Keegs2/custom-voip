"""
Test Webhook Server
Simulates customer webhook endpoint for API calling tests
"""
from flask import Flask, request, Response
import json
import logging
from datetime import datetime

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@app.route('/health')
def health():
    return {'status': 'ok'}


@app.route('/voice', methods=['GET', 'POST'])
def voice_webhook():
    """
    Handle incoming voice webhook from FreeSWITCH.
    Returns XML instructions for call control.
    """
    # Log the request
    logger.info(f"Voice webhook: {request.method}")
    if request.is_json:
        data = request.get_json()
        logger.info(f"JSON data: {json.dumps(data, indent=2)}")
    else:
        logger.info(f"Form data: {dict(request.form)}")

    # Get call parameters
    call_uuid = request.values.get('uuid', 'unknown')
    caller_id = request.values.get('caller_id_number', 'unknown')
    destination = request.values.get('destination_number', 'unknown')
    direction = request.values.get('direction', 'inbound')

    logger.info(f"Call: {call_uuid} | From: {caller_id} | To: {destination} | Dir: {direction}")

    # Return TwiML-style XML instructions
    xml_response = f'''<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice">Welcome to the voice platform test. Your call ID is {call_uuid[-8:]}.</Say>
    <Pause length="1"/>
    <Say>This is a test call to verify the API calling functionality.</Say>
    <Say>The call will now end. Thank you.</Say>
    <Hangup/>
</Response>'''

    return Response(xml_response, mimetype='application/xml')


@app.route('/voice/ivr', methods=['GET', 'POST'])
def voice_ivr():
    """IVR example with gather."""
    xml_response = '''<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather numDigits="1" action="/voice/handle-key" method="POST">
        <Say>Press 1 for sales. Press 2 for support.</Say>
    </Gather>
    <Say>We didn't receive any input. Goodbye.</Say>
    <Hangup/>
</Response>'''

    return Response(xml_response, mimetype='application/xml')


@app.route('/voice/handle-key', methods=['POST'])
def handle_key():
    """Handle DTMF input from gather."""
    digit = request.values.get('Digits', '0')
    logger.info(f"DTMF received: {digit}")

    if digit == '1':
        xml = '''<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Connecting you to sales.</Say>
    <Dial>+15551234567</Dial>
</Response>'''
    elif digit == '2':
        xml = '''<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Connecting you to support.</Say>
    <Dial>+15559876543</Dial>
</Response>'''
    else:
        xml = '''<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Invalid option. Goodbye.</Say>
    <Hangup/>
</Response>'''

    return Response(xml, mimetype='application/xml')


@app.route('/status', methods=['POST'])
def status_callback():
    """Handle call status callbacks."""
    logger.info(f"Status callback received")

    data = request.get_json() if request.is_json else dict(request.form)
    logger.info(f"Status data: {json.dumps(data, indent=2)}")

    # Store status for test verification
    with open('/tmp/call_status.log', 'a') as f:
        f.write(f"{datetime.now().isoformat()} | {json.dumps(data)}\n")

    return {'received': True}


@app.route('/fallback', methods=['GET', 'POST'])
def fallback():
    """Fallback handler when primary webhook fails."""
    logger.warning("Fallback webhook called")

    xml_response = '''<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>We are experiencing technical difficulties. Please try again later.</Say>
    <Hangup/>
</Response>'''

    return Response(xml_response, mimetype='application/xml')


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=9000, debug=True)
