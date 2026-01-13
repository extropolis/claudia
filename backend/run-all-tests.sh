#!/bin/bash
# Automated test runner for Claudia
# Runs unit tests and integration tests

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BACKEND_URL="ws://localhost:3001"
BACKEND_PID=""
TESTS_DIR="$(dirname "$0")/tests"

echo ""
echo "╔═══════════════════════════════════════════════════════════════════════════════╗"
echo "║                      CLAUDIA AUTOMATED TEST SUITE                             ║"
echo "╚═══════════════════════════════════════════════════════════════════════════════╝"
echo ""

# Function to cleanup on exit
cleanup() {
    if [ ! -z "$BACKEND_PID" ]; then
        echo ""
        echo -e "${YELLOW}🛑 Stopping backend server (PID: $BACKEND_PID)...${NC}"
        kill $BACKEND_PID 2>/dev/null || true
        wait $BACKEND_PID 2>/dev/null || true
    fi
}

trap cleanup EXIT INT TERM

# Check if backend is already running
check_backend() {
    echo -e "${BLUE}🔍 Checking if backend is running...${NC}"
    if nc -z localhost 3001 2>/dev/null; then
        echo -e "${GREEN}✅ Backend is already running${NC}"
        return 0
    else
        echo -e "${YELLOW}⚠️  Backend not running${NC}"
        return 1
    fi
}

# Start backend server
start_backend() {
    echo -e "${BLUE}🚀 Starting backend server...${NC}"
    cd "$(dirname "$0")"

    # Build first
    echo -e "${BLUE}📦 Building backend...${NC}"
    npm run build > /dev/null 2>&1

    # Start server in background
    npm run start > /tmp/claudia-test-backend.log 2>&1 &
    BACKEND_PID=$!

    # Wait for server to be ready
    echo -e "${BLUE}⏳ Waiting for backend to be ready...${NC}"
    for i in {1..30}; do
        if nc -z localhost 3001 2>/dev/null; then
            echo -e "${GREEN}✅ Backend ready (PID: $BACKEND_PID)${NC}"
            sleep 2  # Give it a bit more time to fully initialize
            return 0
        fi
        sleep 1
    done

    echo -e "${RED}❌ Backend failed to start${NC}"
    echo -e "${YELLOW}Backend logs:${NC}"
    cat /tmp/claudia-test-backend.log
    exit 1
}

# Run unit tests
run_unit_tests() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════════════════════╗"
    echo "║                              UNIT TESTS                                       ║"
    echo "╚═══════════════════════════════════════════════════════════════════════════════╝"
    echo ""

    UNIT_TEST_PASSED=0
    UNIT_TEST_FAILED=0

    # Result Parser Tests
    if [ -f "$TESTS_DIR/unit/result-parser.test.ts" ]; then
        echo -e "${BLUE}Running result-parser tests...${NC}"
        if npx tsx "$TESTS_DIR/unit/result-parser.test.ts"; then
            UNIT_TEST_PASSED=$((UNIT_TEST_PASSED + 1))
        else
            UNIT_TEST_FAILED=$((UNIT_TEST_FAILED + 1))
        fi
    fi

    # Task Manager Tests
    if [ -f "$TESTS_DIR/unit/task-manager.test.ts" ]; then
        echo -e "${BLUE}Running task-manager tests...${NC}"
        if npx tsx "$TESTS_DIR/unit/task-manager.test.ts"; then
            UNIT_TEST_PASSED=$((UNIT_TEST_PASSED + 1))
        else
            UNIT_TEST_FAILED=$((UNIT_TEST_FAILED + 1))
        fi
    fi

    echo ""
    echo -e "${BLUE}📊 Unit Tests: ${GREEN}${UNIT_TEST_PASSED} passed${NC}, ${RED}${UNIT_TEST_FAILED} failed${NC}"

    return $UNIT_TEST_FAILED
}

# Run integration tests
run_integration_tests() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════════════════════╗"
    echo "║                          INTEGRATION TESTS                                    ║"
    echo "╚═══════════════════════════════════════════════════════════════════════════════╝"
    echo ""

    INTEGRATION_TEST_PASSED=0
    INTEGRATION_TEST_FAILED=0

    # Orchestrator Integration Tests
    if [ -f "$TESTS_DIR/integration/orchestrator.integration.test.ts" ]; then
        echo -e "${BLUE}Running orchestrator integration tests...${NC}"
        if npx tsx "$TESTS_DIR/integration/orchestrator.integration.test.ts"; then
            INTEGRATION_TEST_PASSED=$((INTEGRATION_TEST_PASSED + 1))
        else
            INTEGRATION_TEST_FAILED=$((INTEGRATION_TEST_FAILED + 1))
        fi
    fi

    echo ""
    echo -e "${BLUE}📊 Integration Tests: ${GREEN}${INTEGRATION_TEST_PASSED} passed${NC}, ${RED}${INTEGRATION_TEST_FAILED} failed${NC}"

    return $INTEGRATION_TEST_FAILED
}

# Run CLI tests
run_cli_tests() {
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════════════════════╗"
    echo "║                             CLI TESTS                                         ║"
    echo "╚═══════════════════════════════════════════════════════════════════════════════╝"
    echo ""

    echo -e "${BLUE}Running CLI test with structured output validation...${NC}"
    if npm run test:cli -- --message "echo hello world" --timeout 30000; then
        CLI_TEST_RESULT=0
    else
        CLI_TEST_RESULT=1
    fi

    return $CLI_TEST_RESULT
}

# Main execution
main() {
    # Start backend if not running
    if ! check_backend; then
        start_backend
    fi

    # Track overall results
    TOTAL_FAILURES=0

    # Run unit tests
    if ! run_unit_tests; then
        TOTAL_FAILURES=$((TOTAL_FAILURES + 1))
    fi

    # Run integration tests
    if ! run_integration_tests; then
        TOTAL_FAILURES=$((TOTAL_FAILURES + 1))
    fi

    # Run CLI tests
    if ! run_cli_tests; then
        TOTAL_FAILURES=$((TOTAL_FAILURES + 1))
    fi

    # Print final summary
    echo ""
    echo "╔═══════════════════════════════════════════════════════════════════════════════╗"
    echo "║                           FINAL TEST SUMMARY                                  ║"
    echo "╚═══════════════════════════════════════════════════════════════════════════════╝"
    echo ""

    if [ $TOTAL_FAILURES -eq 0 ]; then
        echo -e "${GREEN}✅ ALL TESTS PASSED${NC}"
        echo ""
        exit 0
    else
        echo -e "${RED}❌ SOME TESTS FAILED${NC}"
        echo -e "${YELLOW}Total test suites with failures: $TOTAL_FAILURES${NC}"
        echo ""
        exit 1
    fi
}

# Run main
main
