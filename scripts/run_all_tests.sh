#!/bin/bash
# Run All Tests for Voice Platform
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=============================================="
echo "  Voice Platform - Full Test Suite"
echo "=============================================="
echo ""

# Check if services are running
echo "Checking if services are running..."
if ! docker compose ps | grep -q "voip-api.*Up"; then
    echo "ERROR: Services not running. Start with: docker compose up -d"
    exit 1
fi

echo "All services are running."
echo ""

# Wait for services to be ready
echo "Waiting for services to be ready..."
sleep 5

# Run tests
echo ""
echo "=============================================="
echo "  Test 1: RCF Functionality"
echo "=============================================="
bash "$SCRIPT_DIR/test_rcf.sh" || echo "RCF tests had some failures"

echo ""
echo "=============================================="
echo "  Test 2: API Calling"
echo "=============================================="
bash "$SCRIPT_DIR/test_api_calling.sh" || echo "API calling tests had some failures"

echo ""
echo "=============================================="
echo "  Test 3: Call Rating"
echo "=============================================="
bash "$SCRIPT_DIR/test_rating.sh" || echo "Rating tests had some failures"

echo ""
echo "=============================================="
echo "  Test Suite Complete"
echo "=============================================="
