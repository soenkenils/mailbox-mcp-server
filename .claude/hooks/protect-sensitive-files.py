#!/usr/bin/env python3
"""Protect sensitive files from accidental changes"""

import json
import sys
import os
from pathlib import Path

# Protected file patterns
PROTECTED_FILES = {
    ".env", "package.json", "biome.json", "tsconfig.json", 
    "vitest.config.ts", ".gitignore", "bun.lock"
}

def is_protected_file(file_path: str) -> bool:
    """Check if file is in protected list or .claude directory."""
    filename = Path(file_path).name
    return filename in PROTECTED_FILES or "/.claude/" in file_path

def create_output(reason: str) -> dict:
    """Create standardized output format."""
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask", 
            "permissionDecisionReason": reason
        }
    }

def main():
    try:
        input_data = json.load(sys.stdin)
        file_path = input_data.get("tool_input", {}).get("file_path", "")
    except (json.JSONDecodeError, KeyError):
        sys.exit(0)
    
    if not file_path or not is_protected_file(file_path):
        sys.exit(0)
    
    filename = Path(file_path).name
    if filename in PROTECTED_FILES:
        reason = f"⚠️  Modifying protected configuration file: {filename}. Are you sure?"
    else:
        reason = f"⚠️  Modifying Claude configuration: {filename}. This affects development workflow."
    
    print(json.dumps(create_output(reason)))

if __name__ == "__main__":
    main()