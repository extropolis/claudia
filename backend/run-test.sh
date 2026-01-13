#!/bin/bash

# Test runner script for structured output testing
# This script helps automate the testing process

set -e

echo "🧪 Structured Output Test Runner"
echo "=================================="
echo ""

# Check if backend is running
echo "🔍 Checking if backend is running..."
if curl -s http://localhost:3001/health > /dev/null 2>&1; then
    echo "✅ Backend is running"
else
    echo "⚠️  Backend not detected at http://localhost:3001"
    echo ""
    echo "To start the backend:"
    echo "  Terminal 1: cd backend && npm run dev"
    echo ""
    read -p "Is the backend running? (y/n) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Please start the backend first"
        exit 1
    fi
fi

echo ""
echo "🏗️  Building TypeScript..."
npm run build

echo ""
echo "🚀 Running test CLI..."
echo ""

# Run the test
npm run test:cli "$@"

echo ""
echo "✅ Test complete!"
