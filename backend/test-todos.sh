#!/bin/bash

BASE_URL="http://localhost:3000/api"

echo "Testing Todo API endpoints..."
echo ""

# Test 1: Create a todo
echo "1. Creating a new todo..."
CREATE_RESPONSE=$(curl -s -X POST "$BASE_URL/todos" \
  -H "Content-Type: application/json" \
  -d '{"title": "Learn TypeScript", "description": "Study TypeScript fundamentals"}')
echo "Response: $CREATE_RESPONSE"
TODO_ID=$(echo $CREATE_RESPONSE | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "Created todo with ID: $TODO_ID"
echo ""

# Test 2: Get all todos
echo "2. Getting all todos..."
curl -s -X GET "$BASE_URL/todos" | grep -q "Learn TypeScript" && echo "✓ Todo found in list" || echo "✗ Todo not found"
echo ""

# Test 3: Get specific todo
echo "3. Getting specific todo by ID..."
curl -s -X GET "$BASE_URL/todos/$TODO_ID" | grep -q "Learn TypeScript" && echo "✓ Todo retrieved successfully" || echo "✗ Failed to retrieve todo"
echo ""

# Test 4: Update todo
echo "4. Updating todo (marking as completed)..."
UPDATE_RESPONSE=$(curl -s -X PUT "$BASE_URL/todos/$TODO_ID" \
  -H "Content-Type: application/json" \
  -d '{"completed": true}')
echo $UPDATE_RESPONSE | grep -q '"completed":true' && echo "✓ Todo updated successfully" || echo "✗ Failed to update todo"
echo ""

# Test 5: Delete todo
echo "5. Deleting todo..."
DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/todos/$TODO_ID")
[ "$DELETE_STATUS" = "204" ] && echo "✓ Todo deleted successfully (HTTP 204)" || echo "✗ Failed to delete todo (HTTP $DELETE_STATUS)"
echo ""

echo "All tests completed!"
