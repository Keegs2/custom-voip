#!/bin/bash
# Configure Homer 7 node aliases for SIP ladder readability

# Get auth token
T=$(curl -s -X POST http://localhost:9080/api/v3/auth \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"sipcapture"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

if [ -z "$T" ]; then
  echo "Failed to get Homer auth token"
  exit 1
fi

echo "Got token, adding aliases..."

# Add each alias individually to avoid JSON parsing issues
add_alias() {
  curl -s -X POST http://localhost:9080/api/v3/alias \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $T" \
    -d "{\"ip\":\"$1\",\"port\":$2,\"alias\":\"$3\"}"
  echo " -> $3 ($1:$2)"
}

add_alias "172.28.0.10" 5080 "FreeSWITCH Internal"
add_alias "172.28.0.10" 5090 "FreeSWITCH External"
add_alias "0.0.0.0" 5060 "Kamailio SBC"
add_alias "34.74.71.32" 5060 "Kamailio SBC (Public)"
add_alias "34.74.71.32" 5080 "FreeSWITCH Internal (Public)"
add_alias "34.74.71.32" 5090 "FreeSWITCH External (Public)"
add_alias "127.0.0.1" 5080 "Kamailio to FS Dispatch"
add_alias "172.28.0.1" 5060 "FS to Kamailio (Docker GW)"
add_alias "67.231.2.12" 5060 "Bandwidth Dallas (Term)"
add_alias "216.82.238.134" 5060 "Bandwidth LA (Term)"
add_alias "67.231.9.142" 5060 "Bandwidth Origination"
add_alias "67.231.13.185" 5060 "Bandwidth Origination 2"

echo "Done. Refresh Homer to see aliases in SIP ladders."
