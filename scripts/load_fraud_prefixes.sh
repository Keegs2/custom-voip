#!/bin/bash
# Load high-risk prefixes into Redis for fast lookups
# Run after starting Redis
set -e

echo "Loading high-risk prefixes into Redis..."

docker exec voip-redis redis-cli <<'EOF'
# Blocked prefixes (immediate rejection)
SET hrp:1900 "blocked"
SET hrp:1976 "blocked"
SET hrp:53 "blocked"
SET hrp:252 "blocked"

# Critical prefixes (high fraud risk)
SET hrp:225 "critical"
SET hrp:231 "critical"
SET hrp:232 "critical"
SET hrp:257 "critical"
SET hrp:375 "critical"
SET hrp:670 "critical"
SET hrp:675 "critical"
SET hrp:678 "critical"
SET hrp:685 "critical"
SET hrp:686 "critical"
SET hrp:691 "critical"

# High-risk prefixes (require monitoring)
SET hrp:267 "high"
SET hrp:284 "high"
SET hrp:381 "high"
SET hrp:679 "high"
SET hrp:687 "high"
SET hrp:880 "high"

# Set TTL to never expire
PERSIST hrp:1900
PERSIST hrp:1976
PERSIST hrp:53
PERSIST hrp:252
PERSIST hrp:225
PERSIST hrp:231
PERSIST hrp:232
PERSIST hrp:257
PERSIST hrp:375
PERSIST hrp:670
PERSIST hrp:675
PERSIST hrp:678
PERSIST hrp:685
PERSIST hrp:686
PERSIST hrp:691
PERSIST hrp:267
PERSIST hrp:284
PERSIST hrp:381
PERSIST hrp:679
PERSIST hrp:687
PERSIST hrp:880

ECHO "Loaded high-risk prefixes into Redis"
EOF

echo "Done. Prefix checks will now work."
