#!/bin/bash
# Schnelle Tests nach Code-Änderungen

set -e
cd "$CLAUDE_PROJECT_DIR"

echo "🧪 Running quick tests..."

# Nur Unit Tests, keine Integration Tests
if bun run test --run --reporter=verbose --exclude="**/integration.test.ts"; then
    echo "✅ Quick tests passed"
else
    echo "❌ Some tests failed"
    exit 1
fi