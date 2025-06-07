# Mailbox.org MCP Server

A Model Context Protocol (MCP) server that integrates mailbox.org email and calendar services with Anthropic's Claude Desktop application. This server enables Claude to access, search, and interact with your personal email and calendar data through a secure, locally-hosted interface.

## Features

### **Email Integration (IMAP)**

- ✅ **Search emails** by text content, sender, subject, and date range
- ✅ **Retrieve complete email content** including headers, body, and attachments
- ✅ **Email thread management** with conversation grouping
- ✅ **Multiple mailbox folder support** (INBOX, Sent, Drafts, etc.)
- ✅ **Attachment detection** and metadata extraction
- ✅ **Session-based caching** for improved performance

### **Calendar Integration (CalDAV)**

- ✅ **Retrieve calendar events** within specified date ranges
- ✅ **Search calendar events** by title, description, location
- ✅ **Free/busy time checking** for scheduling
- ✅ **Multi-calendar support** and aggregation
- ✅ **Recurring events** and exception handling
- ✅ **Session-based caching** for improved performance

## Requirements

- Node.js 20 or later
- A mailbox.org account
- Claude Desktop application

## Installation

1. Clone and build the project:

   ```bash
   git clone <repository-url>
   cd mailbox-mcp-server
   npm install
   npm run build
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

- **`search_emails`** - Search your mailbox by text, sender, date, etc.
- **`get_email`** - Retrieve complete email content by UID
- **`get_email_thread`** - Get conversation threads by message ID

### **Calendar Tools**

- **`get_calendar_events`** - Retrieve events in date range
- **`search_calendar`** - Search events by keyword
- **`get_free_busy`** - Check availability for scheduling

## Configuration

### **Environment Variables**

#### **Required Configuration**

- `MAILBOX_EMAIL`: Your mailbox.org email address (**required**)
- `MAILBOX_PASSWORD`: Your mailbox.org app password (**required**)

#### **Optional Email Configuration**

- `MAILBOX_IMAP_HOST`: IMAP server host (default: `imap.mailbox.org`)
- `MAILBOX_IMAP_PORT`: IMAP server port (default: `993`)
- `MAILBOX_IMAP_SECURE`: Use TLS encryption (default: `true`)

#### **Optional Calendar Configuration**

- `MAILBOX_CALDAV_URL`: CalDAV server URL (default: `https://dav.mailbox.org/`)
- `MAILBOX_CALENDARS`: Comma-separated list of calendars to access

#### **Optional Cache Configuration**

- `CACHE_EMAIL_SEARCH_TTL`: Email search cache TTL in ms (default: `300000`)
- `CACHE_EMAIL_MESSAGE_TTL`: Email message cache TTL in ms (default: `600000`)
- `CACHE_CALENDAR_EVENTS_TTL`: Calendar events cache TTL in ms (default: `900000`)
- `CACHE_MAX_SIZE`: Maximum cache entries (default: `1000`)

#### **Optional Debug Configuration**

- `DEBUG`: Enable debug logging (default: `false`)

### **Security Notes**

- Use **app-specific passwords** instead of your main password for better security
- All credentials are passed via environment variables (no persistent storage)
- Consider using a `.env` file for local development (add it to `.gitignore`)

## Security Features

- ✅ **TLS encryption** for all IMAP, SMTP, CalDAV, and CardDAV connections
- ✅ **Local-only processing** - no data sent to third parties
- ✅ **Environment-based credentials** - no persistent storage of passwords
- ✅ **App-specific password support** for enhanced security
- ✅ **Session-only caching** - all data cleared on restart
- ✅ **Privacy-first architecture** - your data stays on your machine

## Development

### **Setup**

1. Clone the repository:

   ```bash
   git clone <repository-url>
   cd mailbox-mcp-server
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create environment configuration:

   ```bash
   cp .env.example .env
   # Edit .env with your mailbox.org credentials
   ```

### **Available Scripts**

- **`npm run dev`** - Start development server with hot reloading
- **`npm run build`** - Build for production
- **`npm run start`** - Start production server
- **`npm test`** - Run test suite
- **`npm run test:unit`** - Run unit tests only
- **`npm run test:integration`** - Run integration tests only
- **`npm run format`** - Format code with Biome
- **`npm run lint`** - Lint code with Biome
- **`npm run check`** - Run both linting and formatting

### **Testing**

The project includes comprehensive test coverage:

- **Unit tests**: Service layer logic testing
- **Integration tests**: Real mailbox.org API testing  
- **Mock services**: IMAP/CalDAV/CardDAV protocol testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test -- --coverage

# Test specific service
npm run test ImapService
```

## License

MIT License - see LICENSE file for details
