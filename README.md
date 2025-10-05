# Mailbox.org MCP Server

A Model Context Protocol (MCP) server that integrates mailbox.org email and calendar services with Anthropic's Claude Desktop application. This server enables Claude to access, search, and interact with your personal email and calendar data through a secure, locally-hosted interface.

## Features

### **Email Integration (IMAP & SMTP)**

**Reading & Search:**
- ✅ **Search emails** by text content, sender, subject, and date range
- ✅ **Retrieve complete email content** including headers, body, and attachments
- ✅ **Email thread management** with conversation grouping
- ✅ **Folder browsing** and navigation (INBOX, Sent, Drafts, etc.)
- ✅ **Attachment detection** and metadata extraction

**Composition & Management:**
- ✅ **Send emails** with rich content (HTML/text) and attachments
- ✅ **Draft management** - save and edit email drafts
- ✅ **Email organization** - move emails between folders
- ✅ **Flag management** - mark as read/unread, important, etc.
- ✅ **Email deletion** - trash or permanent removal

**Performance:**
- ✅ **Connection pooling** for SMTP and IMAP with health monitoring
- ✅ **Session-based caching** for improved performance

### **Calendar Integration (CalDAV)**

- ✅ **Retrieve calendar events** within specified date ranges
- ✅ **Search calendar events** by title, description, location
- ✅ **Free/busy time checking** for scheduling
- ✅ **Multi-calendar support** and aggregation
- ✅ **Recurring events** and exception handling
- ✅ **Connection pooling** for CalDAV with automatic retry logic
- ✅ **Session-based caching** for improved performance

### **Email Filter Management (Sieve/ManageSieve)**

- ✅ **List and retrieve** existing Sieve filter scripts
- ✅ **Create and update** email filtering rules with Sieve syntax
- ✅ **Activate/deactivate** filter scripts
- ✅ **Delete** unwanted filter scripts
- ✅ **Syntax validation** before deploying filters
- ✅ **Server capabilities** discovery for supported Sieve extensions

## Requirements

- Node.js 20 or later
- A mailbox.org account
- Claude Desktop application

## Installation

1. Clone and build the project:

   ```bash
   git clone <repository-url>
   cd mailbox-mcp-server
   bun install
   bun run build
   ```

2. Copy the example environment file and update it with your credentials:

   ```bash
   cp env.example .env
   ```

   > **Note**: For security, it's recommended to use an [App Password](https://support.mailbox.org/en/help/app-passwords) instead of your main account password.

3. Edit the `.env` file with your mailbox.org credentials:

   ```env
   # Required settings
   MAILBOX_EMAIL=your-email@mailbox.org
   MAILBOX_PASSWORD=your-app-specific-password
   
   # Optional: IMAP configuration (defaults shown)
   MAILBOX_IMAP_HOST=imap.mailbox.org
   MAILBOX_IMAP_PORT=993
   MAILBOX_IMAP_SECURE=true
   
   # Optional: SMTP configuration (defaults shown)
   MAILBOX_SMTP_HOST=smtp.mailbox.org
   MAILBOX_SMTP_PORT=587
   MAILBOX_SMTP_SECURE=true
   
   # Optional: CalDAV configuration (defaults shown) 
   MAILBOX_CALDAV_URL=https://dav.mailbox.org/
   
   # Optional: Enable debug logging
   DEBUG=false
   ```

4. Add to Claude Desktop configuration:

   Add this server to your Claude Desktop `claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "mailbox-mcp-server": {
         "command": "node",
         "args": ["/path/to/mailbox-mcp-server/dist/main.js"]
       }
     }
   }
   ```

## Available Tools

### **Email Tools**

#### **Reading & Search**
- **`search_emails`** - Search your mailbox by text, sender, date, etc.
- **`get_email`** - Retrieve complete email content by UID
- **`get_email_thread`** - Get conversation threads by message ID
- **`get_folders`** - List all available email folders

#### **Composition & Sending**
- **`send_email`** - Compose and send emails with attachments
- **`create_draft`** - Save email drafts for later editing

#### **Email Management**
- **`move_email`** - Move emails between folders
- **`mark_email`** - Mark emails as read/unread, flag as important
- **`delete_email`** - Delete emails (move to trash or permanent)

### **Calendar Tools**

- **`get_calendar_events`** - Retrieve events in date range
- **`search_calendar`** - Search events by keyword
- **`get_free_busy`** - Check availability for scheduling

### **Sieve Filter Tools**

Manage email filtering rules using the [Sieve language](https://tools.ietf.org/html/rfc5228) (RFC 5228) through the ManageSieve protocol.

#### **Script Management**
- **`list_sieve_scripts`** - List all Sieve filter scripts on the server
- **`get_sieve_script`** - Retrieve the content of a specific Sieve script
- **`create_sieve_filter`** - Create or update a Sieve filter script
- **`delete_sieve_script`** - Delete a Sieve script from the server
- **`activate_sieve_script`** - Activate a specific Sieve script (deactivates others)

#### **Script Validation**
- **`check_sieve_script`** - Validate Sieve script syntax without saving
- **`get_sieve_capabilities`** - Get ManageSieve server capabilities and supported extensions

#### **Example Use Cases**

**Automatic Newsletter Filtering:**
```sieve
require ["fileinto"];

if header :contains "From" [
  "newsletter@example.com",
  "news@company.com"
] {
  fileinto "Newsletter";
  stop;
}
```

**Transaction Email Organization:**
```sieve
require ["fileinto"];

if anyof (
  header :contains "From" ["paypal.de", "stripe.com"],
  header :contains "Subject" ["Order", "Receipt", "Invoice"]
) {
  fileinto "Transactional";
  stop;
}
```

**Ask Claude to manage your filters:**
- "Analyze my inbox and suggest email filters"
- "Create a filter to move all GitHub notifications to a Developer folder"
- "Show me all my active Sieve filters"
- "Validate this Sieve script for syntax errors"

## Configuration

### **Environment Variables**

Configuration is automatically validated at startup using comprehensive validation rules. The server will fail fast with clear error messages if any configuration is invalid or missing.

#### **Required Configuration**

- `MAILBOX_EMAIL`: Your mailbox.org email address (**required**)
  - Must be a valid email address format
- `MAILBOX_PASSWORD`: Your mailbox.org app password (**required**)
  - Must be a non-empty string

#### **Optional Email Configuration**

**IMAP (Reading Emails):**
- `MAILBOX_IMAP_HOST`: IMAP server host (default: `imap.mailbox.org`)
  - Must be a non-empty string
- `MAILBOX_IMAP_PORT`: IMAP server port (default: `993`)
  - Must be a valid port number (1-65535)
- `MAILBOX_IMAP_SECURE`: Use TLS encryption (default: `true`)
  - Must be `"true"` or `"false"`

**SMTP (Sending Emails):**
- `MAILBOX_SMTP_HOST`: SMTP server host (default: `smtp.mailbox.org`)
  - Must be a non-empty string
- `MAILBOX_SMTP_PORT`: SMTP server port (default: `465`)
  - Must be a valid port number (1-65535)
- `MAILBOX_SMTP_SECURE`: Use TLS encryption (default: `true`)
  - Must be `"true"` or `"false"`

#### **Optional Calendar Configuration**

- `MAILBOX_CALDAV_URL`: CalDAV server URL (default: `https://dav.mailbox.org/`)
  - Must be a valid URL format
- `MAILBOX_CALENDARS`: Comma-separated list of calendars to access

#### **Optional Sieve Configuration**

- `MAILBOX_SIEVE_HOST`: Sieve server host (default: `imap.mailbox.org`)
  - Must be a non-empty string
- `MAILBOX_SIEVE_PORT`: Sieve server port (default: `4190`)
  - Must be a valid port number (1-65535)
- `MAILBOX_SIEVE_SECURE`: Use TLS encryption (default: `false`)
  - Must be `"true"` or `"false"`

#### **Optional Cache Configuration**

All cache TTL values must be non-negative numbers (in milliseconds):
- `CACHE_EMAIL_SEARCH_TTL`: Email search cache TTL in ms (default: `300000`)
- `CACHE_EMAIL_MESSAGE_TTL`: Email message cache TTL in ms (default: `600000`)
- `CACHE_EMAIL_THREAD_TTL`: Email thread cache TTL in ms (default: `300000`)
- `CACHE_CALENDAR_EVENTS_TTL`: Calendar events cache TTL in ms (default: `900000`)
- `CACHE_CALENDAR_FREEBUSY_TTL`: Calendar free/busy cache TTL in ms (default: `300000`)
- `CACHE_MAX_SIZE`: Maximum cache entries (default: `1000`)
  - Must be a positive integer
- `CACHE_CLEANUP_INTERVAL`: Cache cleanup frequency in ms (default: `300000`)
  - Must be at least 1000ms

#### **Optional Connection Pool Configuration**

**Note:** mailbox.org limits concurrent IMAP connections per account. Using more than 2-3 connections may cause connection issues.

- `POOL_MAX_CONNECTIONS`: Maximum total connections (default: `2` - safe for mailbox.org)
  - Must be between 1 and 100 connections
- `POOL_TIMEOUT_MS`: Connection acquire timeout (default: `15000`)
  - Must be at least 1000ms
- `POOL_IDLE_TIMEOUT_MS`: Idle connection timeout (default: `30000`)
  - Must be at least 1000ms
- `POOL_HEALTH_CHECK_MS`: Health check frequency (default: `6000`)
  - Must be at least 1000ms

#### **Optional Debug Configuration**

- `DEBUG`: Enable debug logging (default: `false`)
  - Must be `"true"` or `"false"`

### **Security Notes**

- Use **app-specific passwords** instead of your main password for better security
- All credentials are passed via environment variables (no persistent storage)
- Consider using a `.env` file for local development (add it to `.gitignore`)

## Security Features

- ✅ **TLS encryption** for all IMAP, SMTP, CalDAV, and CardDAV connections
- ✅ **Connection pooling with health monitoring** - automatic detection and recovery from failed connections
- ✅ **Local-only processing** - no data sent to third parties
- ✅ **Environment-based credentials** - no persistent storage of passwords
- ✅ **App-specific password support** for enhanced security
- ✅ **Session-only caching** - all data cleared on restart
- ✅ **Privacy-first architecture** - your data stays on your machine

## Architecture

### **Connection Pooling**

The server implements robust connection pooling for optimal performance and reliability:

#### **SMTP Connection Pool**
- **Verification Timing**: Connections are verified based on configurable intervals to avoid unnecessary overhead
- **Failure Tracking**: Monitors connection health and automatically destroys connections after repeated failures
- **Retry Logic**: Automatic retry with exponential backoff for failed connection attempts
- **Metrics**: Real-time monitoring of pool status, verification failures, and connection distribution

#### **IMAP Connection Pool**
- **Folder-Aware Pooling**: Connections remember selected folders to minimize folder switching overhead
- **Health Monitoring**: Periodic validation using IMAP NOOP commands
- **Connection Reuse**: Intelligent reuse of connections for the same folder operations
- **State Management**: Automatic cleanup of folder state for unhealthy connections

#### **Base Pool Features**
- **Sensible Defaults**: Production-ready configuration that works out of the box
- **Simple Tuning**: Only 4 configuration variables for essential performance tuning
- **Health Checks**: Background monitoring and cleanup of idle/unhealthy connections
- **Graceful Shutdown**: Proper cleanup of all connections on server termination
- **Error Recovery**: Automatic recreation of failed connections with hardcoded retry logic

#### **Performance Benefits**
- **Reduced Latency**: Connection reuse eliminates costly connection establishment overhead
- **Better Throughput**: Multiple concurrent operations through connection pooling
- **Resource Efficiency**: Automatic scaling based on demand within configured limits
- **Reliability**: Health monitoring ensures only working connections are used

## Development

### **Setup**

1. Clone the repository:

   ```bash
   git clone <repository-url>
   cd mailbox-mcp-server
   ```

2. Install dependencies:

   ```bash
   bun install
   ```

   > **Note**: This project uses bun as the package manager. Make sure you have bun installed (version 1.0 or later recommended).

3. Create environment configuration:

   ```bash
   cp .env.example .env
   # Edit .env with your mailbox.org credentials

### Debugging with Inspector

The MCP Inspector is a powerful tool for debugging and monitoring your MCP server. It provides real-time insights into errors, request/response cycles, and server state.

#### Enabling the Inspector

1. Start the server with inspector enabled:

   ```bash
   MCP_INSPECTOR=true bun start
   ```

2. Access the web UI at `http://localhost:3000/inspector` (port may vary based on your configuration)

#### Key Features

- **Real-time Error Monitoring**
  - View errors as they occur
  - See detailed stack traces and context
  - Filter errors by type and severity

- **Request/Response Inspection**
  - Monitor all MCP protocol messages
  - Inspect request/response payloads
  - View timing information

- **Tool Validation**
  - Validate tool definitions against MCP specifications
  - Get warnings about potential issues

#### Common Debugging Workflow

1. **Reproduce the Issue**
   - Perform the action that causes the error
   - Note any error messages or unexpected behavior

2. **Inspect the Error**
   - Look for red indicators in the Inspector UI
   - Expand error entries for detailed information
   - Check the network tab for failed requests

3. **View Context**
   - Examine the server state at the time of the error
   - Check the request payload and headers
   - Look at previous successful requests for comparison

#### Enabling Verbose Logging

For more detailed debugging information, enable debug mode:

```bash
MCP_DEBUG=true MCP_INSPECTOR=true bun start
```

#### Best Practices

- Keep the Inspector open during development
- Use the search/filter functionality to find specific errors
- Take advantage of the "Resend" feature to retry failed requests
- Use the "Copy as cURL" feature to share reproducible test cases

### **Available Scripts**

- **`bun dev`** - Start development server with hot reloading
- **`bun run build`** - Build for production
- **`bun start`** - Start production server
- **`bun run test`** - Run test suite
- **`bun run test:unit`** - Run unit tests only
- **`bun run test:integration`** - Run integration tests only
- **`bun format`** - Format code with Biome
- **`bun lint`** - Lint code with Biome
- **`bun check`** - Run both linting and formatting

### **Testing**

The project includes comprehensive test coverage:

- **Unit tests**: Service layer logic testing
- **Integration tests**: Real mailbox.org API testing  
- **Mock services**: IMAP/CalDAV/CardDAV protocol testing

```bash
# Run all tests
bun run test

# Run with coverage
bun run test:coverage

# Test specific service
bun run test ImapService
```

## Dependencies

This project relies on the following key dependencies:

- **Runtime Dependencies**
  - `@modelcontextprotocol/sdk` - MCP server implementation
  - `imapflow` - IMAP client for email access
  - `tsdav` - CalDAV client for calendar access
  - `ical.js` - iCalendar parsing library
  - `mailparser` - Email message parsing
  - `dayjs` - Date manipulation library

- **Development Dependencies**
  - `typescript` - TypeScript compiler
  - `vitest` - Testing framework
  - `biome` - Code formatting and linting
  - `@types/*` - TypeScript type definitions

## Troubleshooting

### Common Issues

1. **Connection Issues**
   - Verify your mailbox.org credentials in `.env`
   - Check if your account has IMAP and CalDAV access enabled
   - Ensure your network allows outbound connections to mailbox.org servers

2. **Authentication Failures**
   - Use an App Password instead of your main password
   - Make sure 2FA is properly configured if enabled

3. **Missing Dependencies**

   ```bash
   # If you encounter module not found errors:
   bun install
   ```

4. **Debugging**

   - Enable debug mode for more detailed logs:

     ```bash
     DEBUG=true bun start
     ```

   - Check the [Debugging with Inspector](#debugging-with-inspector) section for advanced troubleshooting

## Contributing

Contributions are welcome! Here's how you can help:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Please make sure to update tests as appropriate and follow the project's code style.

## License

MIT License - see LICENSE file for details
