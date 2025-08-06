#!/bin/bash
# Automatische Code-Formatierung und Linting nach Datei-Änderungen

set -e
cd "$CLAUDE_PROJECT_DIR"

echo "🔍 Running code quality checks..."

# Biome formatting und linting
if bun run check; then
    echo "✅ Code quality checks passed"
else
    echo "⚠️  Code quality issues found - running auto-fix..."
    bun run check
    echo "🔧 Auto-fixes applied"
fi

# TypeScript compilation check
if bun run tsc --noEmit; then
    echo "✅ TypeScript compilation successful"
else
    echo "❌ TypeScript compilation errors found"
    exit 1
fi