#!/bin/bash

# Test CLI Examples - Demonstrates all features
# Make sure the backend is running on localhost:3001

echo "=== Test CLI Examples ==="
echo ""

# 1. Basic chat message
echo "1. Testing basic chat message..."
npx tsx test-cli.ts -m "echo hello world" --timeout 30000
echo ""

# 2. Create a task
echo "2. Testing task creation..."
npx tsx test-cli.ts --task -m "list files in current directory" -n "List Files" --timeout 30000
echo ""

# 3. List all tasks
echo "3. Testing list tasks..."
npx tsx test-cli.ts --list-tasks --timeout 5000
echo ""

# 4. Get configuration
echo "4. Testing get config..."
npx tsx test-cli.ts --get-config --timeout 5000
echo ""

# 5. Enable auto-approve
echo "5. Testing enable auto-approve..."
npx tsx test-cli.ts --auto-approve true --timeout 5000
echo ""

# 6. Verbose mode
echo "6. Testing verbose mode..."
npx tsx test-cli.ts -v -m "pwd" --timeout 30000
echo ""

echo "=== All tests completed ==="
