# Sieve Filter Integration Concept for mailbox-mcp-server

## Executive Summary

This document outlines the concept for integrating Sieve filter management capabilities into the mailbox-mcp-server, enabling Claude Desktop to analyze, create, and manage email filtering rules for mailbox.org accounts through the ManageSieve protocol.

## Background

### Current State

- The mailbox-mcp-server currently provides read/write access to emails and calendar
- Users manually create filters through the mailbox.org web interface
- No programmatic way to manage email filtering rules

### Problem Statement

- Manual filter creation is time-consuming and error-prone
- No intelligent analysis of email patterns for filter suggestions
- Inability to leverage AI for optimizing email organization

## Proposed Solution

### Core Features

1. **Sieve Script Management**
   - List existing Sieve scripts
   - Read/write Sieve scripts
   - Activate/deactivate scripts
   - Validate script syntax

2. **Intelligent Filter Generation**
   - Analyze inbox patterns using AI
   - Generate Sieve rules based on email history
   - Suggest folder organization improvements
   - Auto-categorize senders and domains

3. **MCP Tool Integration**
   - New tools accessible via Claude Desktop
   - Natural language filter creation
   - Interactive filter refinement

## Technical Architecture

### Dependencies

```json
{
  "dependencies": {
    "node-managesieve": "^1.0.0",
    "sieve-parser": "^1.0.0"
  }
}
```

### Service Architecture

```
┌─────────────────┐
│  Claude Desktop │
└────────┬────────┘
         │ MCP Protocol
┌────────▼────────┐
│   MCP Server    │
├─────────────────┤
│  SieveService   │◄──── New Service
├─────────────────┤
│  ImapService    │◄──── Existing
├─────────────────┤
│  CalDavService  │◄──── Existing
└────────┬────────┘
         │ ManageSieve Protocol
┌────────▼────────┐
│  mailbox.org    │
│  Sieve Server   │
│  Port 4190      │
└─────────────────┘
```

### Implementation Components

#### 1. SieveService Class

```typescript
interface SieveService {
  // Connection management
  connect(): Promise<void>
  disconnect(): Promise<void>
  
  // Script operations
  listScripts(): Promise<ScriptInfo[]>
  getScript(name: string): Promise<string>
  putScript(name: string, content: string): Promise<void>
  setActive(name: string): Promise<void>
  deleteScript(name: string): Promise<void>
  
  // Analysis and generation
  analyzeInbox(days: number): Promise<FilterSuggestions>
  generateFilters(suggestions: FilterSuggestions): Promise<string>
  validateScript(content: string): Promise<ValidationResult>
}
```

#### 2. Pattern Analysis Engine

```typescript
interface PatternAnalyzer {
  // Email pattern detection
  analyzeSenders(emails: Email[]): SenderPatterns
  analyzeSubjects(emails: Email[]): SubjectPatterns
  analyzeFrequency(emails: Email[]): FrequencyPatterns
  
  // Categorization
  categorizeEmails(emails: Email[]): EmailCategories
  suggestFolders(categories: EmailCategories): FolderStructure
  
  // Rule generation
  generateRules(patterns: Patterns): SieveRules
}
```

## MCP Tools API

### New Tools

#### 1. `list_sieve_scripts`

```json
{
  "name": "list_sieve_scripts",
  "description": "List all Sieve filter scripts",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

#### 2. `get_sieve_script`

```json
{
  "name": "get_sieve_script",
  "description": "Retrieve a specific Sieve script",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Script name"
      }
    },
    "required": ["name"]
  }
}
```

#### 3. `create_sieve_filter`

```json
{
  "name": "create_sieve_filter",
  "description": "Create or update Sieve filter rules",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "description": "Script name"
      },
      "content": {
        "type": "string",
        "description": "Sieve script content"
      },
      "activate": {
        "type": "boolean",
        "description": "Activate script after creation",
        "default": true
      }
    },
    "required": ["name", "content"]
  }
}
```

#### 4. `analyze_inbox_patterns`

```json
{
  "name": "analyze_inbox_patterns",
  "description": "Analyze email patterns and suggest filters",
  "inputSchema": {
    "type": "object",
    "properties": {
      "days": {
        "type": "number",
        "description": "Number of days to analyze",
        "default": 30
      },
      "folder": {
        "type": "string",
        "description": "Folder to analyze",
        "default": "INBOX"
      }
    }
  }
}
```

#### 5. `generate_smart_filters`

```json
{
  "name": "generate_smart_filters",
  "description": "Generate Sieve filters based on inbox analysis",
  "inputSchema": {
    "type": "object",
    "properties": {
      "categories": {
        "type": "array",
        "description": "Email categories to create filters for",
        "items": {
          "type": "string",
          "enum": ["newsletters", "transactions", "services", "banking", "social"]
        }
      },
      "autoArchive": {
        "type": "boolean",
        "description": "Include auto-archive rules",
        "default": true
      },
      "archiveDays": {
        "type": "number",
        "description": "Days before auto-archiving",
        "default": 90
      }
    }
  }
}
```

## Use Cases

### 1. Initial Setup

```
User: "Analyze my inbox and create automatic filing rules"
Claude: 
1. Analyzes last 30 days of emails
2. Identifies patterns (60% newsletters, 25% transactions, etc.)
3. Generates Sieve script with appropriate rules
4. Activates the script
```

### 2. Natural Language Filter Creation

```
User: "Move all emails from GitHub to a Developer folder"
Claude: Generates and adds rule:
if header :contains "From" "github.com" {
    fileinto "Developer";
    stop;
}
```

### 3. Filter Optimization

```
User: "My filters aren't working well, can you optimize them?"
Claude:
1. Reviews existing Sieve scripts
2. Analyzes recent unfiled emails
3. Suggests improvements or new rules
4. Updates scripts with user approval
```

## Security Considerations

### Authentication

- Use existing mailbox.org credentials from environment
- Support for app-specific passwords
- No credential storage in scripts

### Permissions

- Read-only analysis by default
- Explicit user confirmation for script modifications
- Backup existing scripts before changes

### Validation

- Syntax validation before script upload
- Test mode for new rules
- Rollback capability for problematic filters

## Development Roadmap

### Phase 1: Core Implementation (Week 1-2)

- [x] Research ManageSieve protocol
- [ ] Implement SieveService class
- [ ] Add basic MCP tools (list, get, put)
- [ ] Test with mailbox.org

### Phase 2: Pattern Analysis (Week 3-4)

- [ ] Implement email pattern analyzer
- [ ] Create filter suggestion engine
- [ ] Add analyze_inbox_patterns tool
- [ ] Generate basic Sieve rules

### Phase 3: Smart Features (Week 5-6)

- [ ] Natural language to Sieve conversion
- [ ] Advanced categorization algorithms
- [ ] Filter optimization suggestions
- [ ] Bulk operations support

### Phase 4: Testing & Documentation (Week 7-8)

- [ ] Unit tests for SieveService
- [ ] Integration tests with mailbox.org
- [ ] User documentation
- [ ] Example scripts and templates

## Example Sieve Script Output

```sieve
# Generated by mailbox-mcp-server Sieve Filter Generator
# Date: 2025-08-06
# Analysis based on: 30 days of email history

require ["fileinto", "envelope", "regex", "date", "relational", "variables"];

# ========================================
# IMPORTANT DOCUMENTS & CONTRACTS
# ========================================
if anyof (
    header :contains "From" "docusign.net",
    header :contains "Subject" ["Contract", "Agreement", "Vertrag"]
) {
    fileinto "Important";
    stop;
}

# ========================================
# NEWSLETTERS (60% of inbox)
# ========================================
if header :contains "From" [
    "correctiv.org",
    "krautreporter.de",
    "theverge.com",
    "substack.com",
    "newsletter.dlf.de"
] {
    fileinto "Newsletter";
    stop;
}

# ========================================
# TRANSACTIONAL EMAILS (25% of inbox)
# ========================================
if anyof (
    header :contains "From" ["paypal.de", "shopifyemail.com"],
    header :contains "Subject" ["Order", "Bestellung", "Shipped", "Versand"]
) {
    fileinto "Transactional";
    stop;
}

# ========================================
# BANKING & FINANCIAL
# ========================================
if header :contains "From" [
    "deutsche-bank.de",
    "revolut.com",
    "tomorrow.one"
] {
    fileinto "Banking";
    stop;
}

# ========================================
# AUTO-ARCHIVE (older than 90 days)
# ========================================
if allof (
    header :contains "X-Folder" "Transactional",
    date :value "le" :originalzone "date" "date" "-90"
) {
    fileinto "Archive";
}
```

## Benefits

### For Users

- Save time on email management
- Reduce inbox clutter automatically
- Discover organization patterns
- Natural language filter creation

### For Development

- Extends MCP server capabilities
- Leverages existing authentication
- Reuses connection pooling infrastructure
- Adds unique value to Claude Desktop integration

## Conclusion

The Sieve filter integration will transform the mailbox-mcp-server from a passive email reader into an active email management assistant. By combining Claude's language understanding with programmatic filter management, users can achieve inbox zero with intelligent, adaptive filtering rules.

## References

- [RFC 5228 - Sieve: Email Filtering Language](https://tools.ietf.org/html/rfc5228)
- [RFC 5804 - ManageSieve Protocol](https://tools.ietf.org/html/rfc5804)
- [mailbox.org Sieve Documentation](https://kb.mailbox.org/en/private/custom-mailbox-filters-with-sieve)
- [node-managesieve NPM Package](https://www.npmjs.com/package/node-managesieve)
