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