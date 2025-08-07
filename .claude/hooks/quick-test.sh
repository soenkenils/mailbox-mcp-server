#!/bin/bash
# Quick tests after code changes

set -e
cd "$CLAUDE_PROJECT_DIR"

echo "🧪 Running quick tests..."

# Only unit tests, no integration tests
if bun run test --reporter=verbose --exclude="**/integration.test.ts"; then
    echo "✅ Quick tests passed"
else
    echo "❌ Some tests failed"
    exit 1
fi