# Claude Code Hooks für mailbox-mcp-server

Dieses Dokument beschreibt empfohlene Claude Code Hooks für die Automatisierung und Verbesserung des Entwicklungsworkflows im mailbox-mcp-server Projekt.

## Übersicht

Claude Code Hooks ermöglichen es, automatisch Befehle auszuführen, wenn bestimmte Ereignisse auftreten. Dies verbessert Code-Qualität, Sicherheit und Entwicklungseffizienz.

## Empfohlene Hook-Konfiguration

### Basis-Konfiguration (`.claude/settings.json`)

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/format-check.sh",
            "timeout": 30
          }
        ]
      },
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/quick-test.sh",
            "timeout": 60
          }
        ]
      },
      {
        "matcher": "mcp__mailbox.*",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/monitor-mcp-tools.py",
            "timeout": 15
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/protect-sensitive-files.py",
            "timeout": 10
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/validate-bash-commands.py",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-credentials.py",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/load-project-context.sh",
            "timeout": 20
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/integration-test-check.sh",
            "timeout": 90
          }
        ]
      }
    ]
  }
}
```

## Hook-Implementierungen

### 1. Code Quality Hooks

#### `.claude/hooks/format-check.sh`

```bash
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
    bun run check --write
    echo "🔧 Auto-fixes applied"
fi

# TypeScript compilation check
if bun run tsc --noEmit; then
    echo "✅ TypeScript compilation successful"
else
    echo "❌ TypeScript compilation errors found"
    exit 1
fi
```

#### `.claude/hooks/quick-test.sh`

```bash
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
```

### 2. Security & Protection Hooks

#### `.claude/hooks/protect-sensitive-files.py`

```python
#!/usr/bin/env python3
"""Schutz für sensible Dateien vor versehentlichen Änderungen"""

import json
import sys
import os

def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
    
    tool_input = input_data.get("tool_input", {})
    file_path = tool_input.get("file_path", "")
    
    if not file_path:
        sys.exit(0)
    
    # Sensible Dateien, die geschützt werden sollen
    protected_patterns = [
        ".env",
        "package.json",
        "biome.json",
        "tsconfig.json",
        "vitest.config.ts",
        ".gitignore",
        "bun.lock"
    ]
    
    # Prüfe ob es eine geschützte Datei ist
    for pattern in protected_patterns:
        if pattern in os.path.basename(file_path):
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": f"⚠️  Modifying protected configuration file: {os.path.basename(file_path)}. Are you sure?"
                }
            }
            print(json.dumps(output))
            sys.exit(0)
    
    # Prüfe auf .claude Verzeichnis
    if "/.claude/" in file_path:
        output = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse", 
                "permissionDecision": "ask",
                "permissionDecisionReason": f"⚠️  Modifying Claude configuration: {os.path.basename(file_path)}. This affects development workflow."
            }
        }
        print(json.dumps(output))
        sys.exit(0)

if __name__ == "__main__":
    main()
```

#### `.claude/hooks/check-credentials.py`

```python
#!/usr/bin/env python3
"""Überprüfung auf versehentliche Credential-Eingaben"""

import json
import sys
import re

def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
    
    prompt = input_data.get("prompt", "")
    
    # Patterns für potenzielle Credentials
    sensitive_patterns = [
        (r"(?i)\b(password|secret|key|token)\s*[:=]\s*['\"]?[\w\-\+/=]{8,}", "Potential credential detected"),
        (r"(?i)MAILBOX_PASSWORD\s*=\s*['\"]?[\w\-\+/=]{8,}", "Mailbox password detected"),
        (r"(?i)MAILBOX_EMAIL\s*=\s*[\w\.\-]+@[\w\.\-]+", "Email address detected"),
        (r"(?i)\b[A-Za-z0-9+/]{20,}={0,2}\b", "Potential base64 encoded secret"),
    ]
    
    for pattern, message in sensitive_patterns:
        if re.search(pattern, prompt):
            output = {
                "decision": "block",
                "reason": f"🔒 Security Policy Violation: {message}. Please use environment variables or configuration files instead of including credentials directly in prompts."
            }
            print(json.dumps(output))
            sys.exit(0)
    
    # Füge Projekt-Kontext hinzu
    context = f"""
📧 mailbox-mcp-server Development Context:
- Use environment variables for credentials (see env.example)
- Connection pooling limits: max 2-3 concurrent IMAP connections
- Available MCP tools: email, calendar, sieve filters
- Test with: bun run test:imap for integration tests
"""
    
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context
        }
    }
    print(json.dumps(output))

if __name__ == "__main__":
    main()
```

### 3. MCP Server Development Hooks

#### `.claude/hooks/monitor-mcp-tools.py`

```python
#!/usr/bin/env python3
"""Monitoring und Logging von MCP Tool-Verwendung"""

import json
import sys
import datetime
import os

def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
    
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})
    
    if not tool_name.startswith("mcp__mailbox"):
        sys.exit(0)
    
    # Log MCP tool usage
    log_entry = {
        "timestamp": datetime.datetime.now().isoformat(),
        "tool": tool_name,
        "success": True,
        "session_id": input_data.get("session_id", "")
    }
    
    log_file = os.path.join(os.environ.get("CLAUDE_PROJECT_DIR", "."), ".claude", "mcp-usage.log")
    
    try:
        with open(log_file, "a") as f:
            f.write(json.dumps(log_entry) + "\n")
    except Exception:
        pass  # Logging failure shouldn't block development
    
    print(f"📊 MCP Tool used: {tool_name}")

if __name__ == "__main__":
    main()
```

#### `.claude/hooks/validate-bash-commands.py`

```python
#!/usr/bin/env python3
"""Validierung von Bash-Befehlen für bessere Praktiken"""

import json
import sys
import re

def main():
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
    
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})
    command = tool_input.get("command", "")
    
    if tool_name != "Bash" or not command:
        sys.exit(0)
    
    # Validation rules for better practices
    validation_rules = [
        (r"\bgrep\b(?!.*\|)", "💡 Consider using 'rg' (ripgrep) instead of 'grep' for better performance"),
        (r"\bfind\s+\S+\s+-name\b", "💡 Consider using 'rg --files -g pattern' instead of 'find -name' for better performance"),
        (r"\bnpm\b", "💡 This project uses Bun - consider 'bun' instead of 'npm'"),
        (r"\byarn\b", "💡 This project uses Bun - consider 'bun' instead of 'yarn'"),
        (r"rm\s+-rf\s+/", "⚠️  Dangerous command detected: rm -rf with absolute path"),
        (r"sudo\s+rm", "⚠️  Dangerous command detected: sudo rm"),
    ]
    
    issues = []
    dangerous = False
    
    for pattern, message in validation_rules:
        if re.search(pattern, command):
            issues.append(message)
            if "⚠️" in message:
                dangerous = True
    
    if issues:
        if dangerous:
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "ask",
                    "permissionDecisionReason": f"Dangerous command detected:\n" + "\n".join(issues)
                }
            }
            print(json.dumps(output))
        else:
            for issue in issues:
                print(issue, file=sys.stderr)

if __name__ == "__main__":
    main()
```

### 4. Development Workflow Hooks

#### `.claude/hooks/load-project-context.sh`

```bash
#!/bin/bash
# Lädt relevanten Projekt-Kontext beim Session-Start

cd "$CLAUDE_PROJECT_DIR"

echo "📧 mailbox-mcp-server Project Status:"
echo "================================="

# Git status
echo "📂 Git Status:"
git status --porcelain | head -10
echo ""

# TypeScript compilation
echo "🔧 TypeScript Compilation:"
if bun run tsc --noEmit > /dev/null 2>&1; then
    echo "✅ No TypeScript errors"
else
    echo "❌ TypeScript errors present"
fi
echo ""

# Available MCP tools
echo "🛠️  Available MCP Tools:"
find src/tools/ -name "*.ts" | wc -l | xargs echo "  - Tool files:"
echo ""

# Test status
echo "🧪 Test Status:"
if [ -f "coverage/coverage-final.json" ]; then
    echo "  - Coverage report available"
else
    echo "  - No coverage report (run: bun run test:coverage)"
fi
echo ""

# Environment setup
echo "⚙️  Environment:"
if [ -f ".env" ]; then
    echo "  - .env file present"
else
    echo "  - ⚠️  No .env file (copy from env.example)"
fi

# Dependencies
echo "  - Package manager: Bun $(bun --version 2>/dev/null || echo 'not installed')"
echo "  - Node.js: $(node --version 2>/dev/null || echo 'not installed')"
echo ""

# Recent changes
echo "📝 Recent Changes:"
git log --oneline -5 2>/dev/null || echo "  - No git history"
```

#### `.claude/hooks/integration-test-check.sh`

```bash
#!/bin/bash
# Optionale Integration Tests nach größeren Änderungen

cd "$CLAUDE_PROJECT_DIR"

echo "🔍 Checking if integration tests should be run..."

# Prüfe ob kritische Dateien geändert wurden
if git diff --name-only HEAD~1..HEAD 2>/dev/null | grep -E "(src/services|src/tools|src/main.ts)" > /dev/null; then
    echo "🧪 Critical files changed - recommend running integration tests"
    echo "Run manually: bun run test:imap"
    echo "Full test suite: bun run test:coverage"
else
    echo "✅ No critical changes detected"
fi

# Prüfe Projekt-Gesundheit
echo ""
echo "📊 Project Health Check:"

# Biome check
if bun run lint > /dev/null 2>&1; then
    echo "✅ Linting passed"
else
    echo "⚠️  Linting issues found"
fi

# Build check
if bun run build > /dev/null 2>&1; then
    echo "✅ Build successful"
else
    echo "❌ Build failed"
fi
```

## Setup Instructions

### 1. Hook-Verzeichnis erstellen

```bash
mkdir -p .claude/hooks
```

### 2. Hook-Skripte erstellen

Kopiere alle Skripte in das `.claude/hooks/` Verzeichnis und mache sie ausführbar:

```bash
chmod +x .claude/hooks/*.sh
chmod +x .claude/hooks/*.py
```

### 3. Konfiguration aktivieren

Erstelle `.claude/settings.json` mit der oben gezeigten Basis-Konfiguration.

### 4. Testing

Teste die Hooks mit:

```bash
claude --debug
```

## Hook-Kategorien

### Code Quality (PostToolUse)
- ✅ Automatische Formatierung nach Datei-Änderungen
- ✅ TypeScript Compilation Check
- ✅ Schnelle Unit Tests

### Security (PreToolUse & UserPromptSubmit)
- ✅ Schutz sensibler Konfigurationsdateien
- ✅ Credential-Detection in Prompts
- ✅ Bash-Command Validation

### MCP Development (PostToolUse)
- ✅ MCP Tool Usage Monitoring
- ✅ Connection Pool Überwachung

### Workflow (SessionStart & Stop)
- ✅ Projekt-Kontext beim Start
- ✅ Integration Test Empfehlungen
- ✅ Projekt-Gesundheits-Checks

## Vorteile

1. **Automatisierte Code-Qualität**: Formatierung und Tests laufen automatisch
2. **Sicherheit**: Schutz vor versehentlichen gefährlichen Operationen
3. **Entwicklungseffizienz**: Relevanter Kontext wird automatisch geladen
4. **MCP-spezifisch**: Überwachung der mailbox.org Integration
5. **Proaktive Checks**: Probleme werden früh erkannt

## Anpassungen

Die Hooks können je nach Entwicklungsanforderungen angepasst werden:

- Timeout-Werte ändern
- Zusätzliche Validierungsregeln hinzufügen
- Neue Tool-spezifische Hooks erstellen
- Projektspezifische Checks implementieren

## Debugging

Bei Problemen mit Hooks:

```bash
# Debug-Modus aktivieren
claude --debug

# Hook-Status prüfen
/hooks

# Manuelle Ausführung testen
.claude/hooks/format-check.sh
```
