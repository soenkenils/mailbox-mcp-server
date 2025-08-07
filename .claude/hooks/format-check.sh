#!/bin/bash
# Automatische Code-Formatierung und Linting nach Datei-Änderungen

cd "$CLAUDE_PROJECT_DIR" || exit 1

echo "🔍 Running code quality checks..."

# Run biome linting only and show clean output
LINT_OUTPUT=$(bun run lint 2>&1)
if echo "$LINT_OUTPUT" | grep -q "Linting.*files"; then
    LINTED_LINE=$(echo "$LINT_OUTPUT" | grep "Linting.*files" | head -1)
    echo "✅ $LINTED_LINE"
else
    echo "✅ No linting issues found"
fi

# Run biome formatting only and show clean output
CHECK_OUTPUT=$(bun run biome format --write src/ tests/ 2>&1)
if echo "$CHECK_OUTPUT" | grep -q "Formatted.*files"; then
    FORMATTED_LINE=$(echo "$CHECK_OUTPUT" | grep "Formatted.*files" | head -1)
    echo "✅ $FORMATTED_LINE"
else
    echo "✅ Code already formatted"
fi