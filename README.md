# Mailbox.org MCP Server

A Model Context Protocol (MCP) server that integrates mailbox.org email, calendar, and contact services with Anthropic's Claude Desktop application. This server enables Claude to access, search, and interact with your personal email and calendar data through a secure, locally-hosted interface.

## Features

### **Email Integration (IMAP + SMTP)**

- ✅ **Search emails** by text content, sender, subject, and date range
- ✅ **Retrieve complete email content** including headers, body, and attachments
- ✅ **Send new emails** with rich text and HTML formatting
- ✅ **Reply to emails** with proper threading (reply vs reply-all)
- ✅ **Forward emails** with original content and attachments
- ✅ **Move emails** between folders
- ✅ **Set email flags** (mark as read/unread, flagged, etc.)
- ✅ **Email thread management** with conversation grouping
- ✅ **Multiple mailbox folder support** (INBOX, Sent, Drafts, etc.)
- ✅ **Attachment detection** and metadata extraction

### **Calendar Integration (CalDAV)**

- ✅ **Retrieve calendar events** within specified date ranges
- ✅ **Search calendar events** by title, description, location
- ✅ **Free/busy time checking** for scheduling
- ✅ **Multi-calendar support** and aggregation
- ✅ **Recurring events** and exception handling
- ✅ **Timezone-aware** event processing

### **Contact Integration (CardDAV)**
- ✅ **Search contacts** by name, email, phone, or organization
- ✅ **Complete contact profiles** with all fields (addresses, phones, etc.)
- ✅ **Contact groups and categories**
- ✅ **Fuzzy matching** for partial searches
- ✅ **Multi-addressbook support**

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
   cp .env.example .env
   ```

   > **Note**: For security, it's recommended to use an [App Password](https://support.mailbox.org/en/help/app-passwords) instead of your main account password.

3. Edit the `.env` file with your mailbox.org credentials:

   ```env
   # Required settings
   IMAP_HOST=imap.mailbox.org
   IMAP_PORT=993
   IMAP_USER=your-email@mailbox.org
   IMAP_PASSWORD=your-app-specific-password
   
   # CalDAV (optional, uses IMAP credentials if not set)
   CALDAV_URL=https://dav.mailbox.org/caldav/your-calendar-path
   CALDAV_USER=your-email@mailbox.org
   CALDAV_PASSWORD=your-app-specific-password
   
   # CardDAV (optional, uses IMAP credentials if not set)
   CARDDAV_URL=https://dav.mailbox.org/carddav/your-addressbook-path
   CARDDAV_USER=your-email@mailbox.org
   CARDDAV_PASSWORD=your-app-specific-password
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
- **`get_email`** - Retrieve complete email content by ID
- **`send_email`** - Send new emails with to/cc/bcc recipients
- **`reply_email`** - Reply to existing emails (reply vs reply-all)
- **`forward_email`** - Forward emails with optional attachments
- **`move_email`** - Move emails between folders
- **`set_email_flags`** - Mark emails as read/unread, flagged, etc.
- **`get_email_thread`** - Get conversation threads

### **Calendar Tools**
- **`get_calendar_events`** - Retrieve events in date range
- **`search_calendar`** - Search events by keyword
- **`get_free_busy`** - Check availability for scheduling

### **Contact Tools**
- **`search_contacts`** - Search contacts by name, email, organization
- **`get_contact_details`** - Get complete contact information

## Configuration

### **Environment Variables**

#### **Email Configuration**
- `IMAP_HOST`: IMAP server host (default: `imap.mailbox.org`)
- `IMAP_PORT`: IMAP server port (default: `993`)
- `IMAP_TLS`: Use TLS encryption (default: `true`)
- `IMAP_USER`: Your mailbox.org username (**required**)
- `IMAP_PASSWORD`: Your mailbox.org password (**required**)

#### **Calendar & Contacts Configuration**
- `CALDAV_URL`: CalDAV server URL (default: `dav.mailbox.org`)

#### **Calendar & Contacts Configuration**
- `CALDAV_URL`: CalDAV server URL (default: `dav.mailbox.org`)
- `CALDAV_USER`: CalDAV username (defaults to `IMAP_USER`)
- `CALDAV_PASSWORD`: CalDAV password (defaults to `IMAP_PASSWORD`)
- `CARDDAV_URL`: CardDAV server URL (default: `dav.mailbox.org`)
- `CARDDAV_USER`: CardDAV username (defaults to `IMAP_USER`)
- `CARDDAV_PASSWORD`: CardDAV password (defaults to `IMAP_PASSWORD`)

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
