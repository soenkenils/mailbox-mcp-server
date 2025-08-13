# Technical Concept: Local MCP Server for mailbox.org Integration

## Executive Summary

This document outlines the technical architecture and implementation approach for a local Model Context Protocol (MCP) server that integrates mailbox.org email and calendar services with Anthropic's Claude Desktop application. The solution provides secure, local access to personal email and calendar data through a locally-hosted Node.js server that communicates with Claude Desktop via the MCP protocol.

## Introduction: Model Context Protocol (MCP) and Local Servers

Model Context Protocol (MCP) is Anthropic's open standard for securely connecting AI systems with external data sources. MCP servers are typically executed as local processes that communicate with Claude Desktop through stdio (Standard Input/Output) or other IPC mechanisms.

A local MCP server provides direct, secure access to personal data without cloud dependencies. The server runs as a standalone Node.js process on the local system and is automatically started and managed by Claude Desktop.

**Communication Flow**:

```
Claude Desktop ←→ MCP Server (stdio) ←→ mailbox.org (IMAP/CalDAV)
```

## System Architecture and Data Sources

### mailbox.org Protocol Integration

#### Email Access via IMAP

**Connection Parameters**:

- **Server**: imap.mailbox.org:993 (IMAP)
- **Authentication**: App-specific passwords recommended
- **Core Features**: Basic IMAP operations for reading and searching emails

#### Calendar Access via CalDAV

**CalDAV Integration**:

- **Base URL**: <https://dav.mailbox.org/>
- **Standard**: RFC 4791 CalDAV compliance
- **Operations**: Read calendar events, create/update events

### Local Data Processing and Session Caching

#### Simple Session Caching

**Temporary in-memory storage** to avoid redundant API calls:

- Email searches cached for 5 minutes
- Calendar events cached for 15 minutes
- Cache clears completely on application restart

#### Direct API Philosophy

**Always fetch fresh data** from mailbox.org:

- No persistent database required
- No synchronization complexity
- Current data guaranteed
- Privacy-first approach (no local storage)

#### Credential Management

**Current Implementation (Simple local storage)**:

- Environment variables for credentials
- App-specific passwords for mailbox.org

## MCP Server Implementation

### Core Server Architecture

#### Server Initialization and Lifecycle

```typescript
class MailboxMcpServer {
  private server: Server;
  private services: {
    email: EmailService;
    calendar: CalendarService;
    smtp?: SmtpService;
  };
  private cache: LocalCache;
  private config: ServerConfig;

  constructor() {
    this.initializeServer();
    this.initializeServices();
    this.setupToolHandlers();
  }
}
```

#### Tool Definition and Schema Validation

**Email Tools (Implemented)**:

- `search_emails`: Full-text search with folder filter and time range limitation
- `get_email`: Complete email content with attachment references
- `get_email_thread`: Conversation threading with chronological sorting
- `send_email`: Compose and send emails via SMTP
- `create_draft`: Save emails as drafts
- `move_email`: Move emails between folders
- `mark_email`: Add/remove flags (read, important, etc.)
- `delete_email`: Delete emails (trash or permanent)
- `get_folders`: List all available email folders
- `create_directory`: Create new email folders

**Calendar Tools (Implemented)**:

- `get_calendar_events`: Time-based event queries with recurrence resolution
- `search_calendar`: Full-text search in event titles, descriptions, and locations
- `get_free_busy`: Availability analysis for appointment scheduling

### Service Implementation

#### Email Service

**Direct IMAP access** with basic caching:

- Check session cache first
- Perform IMAP search if cache miss
- Cache results for 5 minutes
- Support for basic folder operations

#### Calendar Service  

**CalDAV integration** for calendar access:

- Direct CalDAV queries for events
- Basic recurrence rule handling
- Session caching for 15 minutes
- Multi-calendar support

### Error Handling and Resilience

#### Simple Error Strategies

**Network Issues**:

- Automatic reconnection with basic retry logic
- Fallback to cached data when available
- Clear error messages for users

**Authentication Problems**:

- Credential refresh workflows
- Graceful degradation to read-only mode
- User-friendly error reporting

## Performance and Scalability

### Simple Performance Approach

#### Memory Management

**Basic session caching**:

- Simple Map-based cache with TTL
- Automatic cleanup on restart
- Size limits to prevent memory issues

#### Connection Efficiency

**Robust Connection Pooling Architecture**:

- **Multi-Protocol Support**: Dedicated pools for SMTP, IMAP, and CalDAV connections
- **Health Monitoring**: Continuous validation and automatic recovery from failed connections
- **Intelligent Reuse**: Connection-specific optimizations (folder awareness for IMAP, verification timing for SMTP)
- **Configurable Scaling**: Min/max connection limits with automatic scaling based on demand
- **Retry Logic**: Exponential backoff and automatic retry for failed connection attempts
- **Performance Metrics**: Real-time monitoring of pool status, failures, and resource utilization
- Cache to reduce redundant requests
- Basic rate limiting protection

### Scaling Considerations

**For larger datasets**:

- Paginated email loading when needed
- Background prefetching for active folders
- Simple multi-account support if required

## Security and Privacy

### Simple Security Model

#### Credential Storage

**Environment variable storage**:

- Environment variables for all credentials
- App-specific passwords for mailbox.org
- No credential transmission to third parties

#### Data Protection

**Privacy-first approach**:

- All processing happens locally
- No persistent data storage
- Session cache only (clears on restart)
- Direct connections to mailbox.org only

#### Network Security

**Standard protections**:

- TLS encryption for all connections
- Certificate validation
- Basic rate limiting to respect mailbox.org limits

## Development and Deployment

### Local Development Environment

#### Development Tools

**Modern Development Workflow**:
The development environment leverages modern tooling for optimal developer experience. Vitest provides fast test execution with native TypeScript support and better ESM compatibility. Biome offers significantly faster linting and formatting compared to traditional tools.

**Essential Development Features**:

- **Hot Reloading**: Automatic server restart on code changes
- **Debug Support**: Integrated debugging with IDE support
- **Fast Testing**: Vitest for rapid test execution and hot test reloading
- **Unified Tooling**: Biome for both linting and formatting in a single tool
- **Type Checking**: Continuous TypeScript validation
- **Build Process**: Optimized compilation for distribution

#### Testing Strategy

**Comprehensive Test Coverage**:

- Unit tests for service layer logic
- Integration tests against mailbox.org test accounts
- Mock server for IMAP/CalDAV protocol testing
- End-to-end tests with Claude Desktop integration
- Performance tests for large dataset handling

### Distribution and Installation

#### NPM Package Distribution

**Package Configuration**:

```json
{
  "name": "@username/mailbox-mcp-server",
  "bin": {
    "mailbox-mcp-server": "./dist/main.js"
  },
  "files": ["dist/", "README.md", "LICENSE"],
  "engines": {
    "node": ">=20.0.0"
  },
  "peerDependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

#### Claude Desktop Integration

**Manual Setup Process**:

- Manual Claude Desktop configuration via claude_desktop_config.json
- Environment variable configuration for credentials
- Validation available via connection testing
- Documentation available in README and code comments

### Maintenance and Updates

#### Manual Update Process

**Standard NPM Updates**:

- Manual NPM package updates
- Configuration compatibility maintained
- Version management via package.json
- Change log available in repository

#### Basic Monitoring

**Simple Support Features**:

- Console logging for errors and operations
- Connection pool metrics available
- Community support via GitHub issues
- Error reporting through standard console output

## Technology Stack and Dependencies

### Core Technology Stack

- **Runtime**: Node.js 20+ with TypeScript 5+
- **MCP SDK**: @modelcontextprotocol/sdk for protocol implementation
- **Email Client**: imapflow for IMAP, nodemailer for SMTP
- **Calendar Client**: tsdav for CalDAV implementation
- **Calendar Parsing**: ical.js for iCalendar format processing
- **Message Parsing**: mailparser for email content extraction
- **Session Cache**: In-memory Map-based caching for temporary data
- **Testing**: Vitest for fast test execution
- **Code Quality**: Biome for linting and formatting

### Current Implementation Libraries

**Core Dependencies (Implemented)**:

- **@modelcontextprotocol/sdk**: MCP protocol implementation
- **imapflow**: IMAP client for email access with connection pooling support
- **nodemailer**: SMTP client for email sending with connection pooling
- **mailparser**: Email message parsing and content extraction
- **tsdav**: CalDAV client for calendar access
- **ical.js**: iCalendar format parsing and processing
- **dayjs**: Date manipulation and timezone handling
- **node-fetch**: HTTP client for CalDAV requests

**Development Dependencies (Implemented)**:

- **TypeScript 5+**: Static typing and modern JavaScript features
- **tsx**: Development server with hot reloading
- **Vitest**: Fast testing framework with native TypeScript support
- **Biome**: Fast linter and formatter for code quality

### Session Cache Implementation

**Lightweight In-Memory Caching Architecture**:

The session cache provides temporary storage for API responses to improve performance while maintaining data freshness. The cache automatically expires entries based on configurable TTL values and includes cleanup mechanisms to prevent memory leaks.

**Cache Design Principles**:

- **Automatic Expiration**: Entries expire based on data type and update frequency
- **Memory Management**: LRU eviction and size limits prevent unlimited growth
- **Cleanup Automation**: Background processes remove expired entries
- **Cache Invalidation**: Pattern-based invalidation for related data updates
- **Session Scope**: Cache cleared completely on application restart

**Service Integration**:
Each service (Email, Calendar) integrates with the session cache using service-specific cache keys and TTL values. The cache provides transparent performance improvements without affecting the real-time nature of data access.

### Connection Pooling Architecture

**Enterprise-Grade Connection Management**:

The system implements a sophisticated three-tier connection pooling architecture designed for performance, reliability, and resource efficiency.

**Base ConnectionPool Class**:
- **Generic Pool Management**: Type-safe connection wrapper management for any connection type
- **Health Monitoring**: Continuous background validation with configurable intervals
- **Retry Logic**: Exponential backoff with configurable max attempts and delay intervals
- **Metrics Collection**: Real-time monitoring of pool status, errors, and resource utilization
- **Graceful Lifecycle**: Proper connection cleanup on shutdown with timeout handling

**SMTP Connection Pool Specialization**:
- **Verification Timing Control**: Intelligent verification scheduling based on last verified timestamp
- **Failure Tracking**: Per-connection failure count with automatic destruction after threshold
- **Transport Optimization**: Nodemailer transport configuration optimized for pooling
- **Performance Metrics**: SMTP-specific metrics including verification failures and timing

**IMAP Connection Pool Specialization**:
- **Folder-Aware Pooling**: Connections maintain selected folder state for optimization
- **Smart Folder Switching**: Automatic folder selection with connection reuse
- **State Management**: Automatic cleanup of folder state for unhealthy connections
- **Invalidation Patterns**: Folder-specific connection invalidation for cache coherency

**Configuration Management**:
- **Environment-Based Config**: All pool settings configurable via environment variables
- **Sensible Defaults**: Production-ready defaults with development-friendly overrides
- **Resource Limits**: Configurable min/max connections, timeouts, and resource bounds
- **Monitoring Integration**: Built-in metrics collection for operational visibility

**No Database Dependencies**:

- No schema files, migrations, or database setup required
- No persistent storage configuration or maintenance
- No data synchronization concerns between local and remote data
- Simple deployment with zero external database dependencies
- Automatic cleanup of all cached data on application termination

## Conclusion

This simplified MCP server provides secure, real-time access to mailbox.org email and calendar data for Claude Desktop. The architecture prioritizes simplicity and maintainability while delivering reliable functionality.

**Key Design Principles**:

- **Simple Architecture**: Direct API access with intelligent connection pooling for performance
- **Real-time Data**: Always current information from mailbox.org with connection reuse optimization
- **Enterprise Reliability**: Robust connection management with health monitoring and automatic recovery
- **Session-only Caching**: Performance benefits without storage complexity  
- **Privacy-first**: All processing local, no persistent data storage
- **Easy Deployment**: Standard npm package with minimal setup requirements
- **Maintainable Code**: Clean, focused implementation with production-grade connection management

The solution eliminates common complexity sources like database management and synchronization logic while providing enterprise-grade connection management and all essential email and calendar functionality needed for Claude Desktop integration.

---

**Document Version**: 1.1  
**Last Updated**: 2025-07-05
**Status**: Updated to reflect actual implementation  
**Author**: Technical Architecture Team  
**Review**: Updated to match reality
