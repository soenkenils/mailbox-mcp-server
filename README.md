# Mailbox.org MCP Server

A Model Context Protocol (MCP) server that integrates mailbox.org email and calendar services with Anthropic's Claude Desktop application. This server enables Claude to access, search, and interact with your personal email and calendar data through a secure, locally-hosted interface.

## Features

### **Email Integration (IMAP & SMTP)**

**Reading & Search:**
- ✅ **Search emails** by text content, sender, subject, date range, and message flags (read/unread, flagged, answered, draft, deleted)
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
- ✅ **Create calendar events** (timed or all-day, with attendees)
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
   cp .env.example .env
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
   MAILBOX_SMTP_PORT=465
   MAILBOX_SMTP_SECURE=true
   
   # Optional: CalDAV configuration (defaults shown) 
   MAILBOX_CALDAV_URL=https://dav.mailbox.org/
   
   # Optional: Enable debug logging
   DEBUG=false
   ```

   > **Note**: The server reads its configuration from environment variables
   > only; it does not load `.env` itself. Bun loads `.env` from the working
   > directory when it runs the code (`bun src/main.ts`, `bun dist/main.js`);
   > `node` needs `node --env-file=.env dist/main.js`. In Claude Desktop, set
   > the variables in the server's `env` block instead.

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

Every tool carries [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-annotations): a human-readable title plus hints that tell the client whether the tool only reads (`readOnlyHint`), can destroy data (`destructiveHint`), is safe to repeat (`idempotentHint`) and reaches outside your mailbox (`openWorldHint`). Clients use them to decide what to run freely and what to confirm with you first. The "Hints" column below summarises them for email and Sieve; the calendar reads (`get_calendar_events`, `search_calendar`, `get_free_busy`) are read-only, `create_calendar_event` is additive, `update_calendar_event` and `delete_calendar_event` are destructive, and all three calendar writes are open-world because they can email participants when asked to.

Each input schema is closed (`additionalProperties: false`). Undeclared arguments are ignored: they are dropped before validation, never reach the mail, calendar or Sieve server, and only their names are logged at debug level. Declared arguments are validated as before. `update_calendar_event` and `delete_calendar_event` are the exception and refuse undeclared arguments, so an edit is never reported for a field that was not applied.

### **Email Tools**

| Tool | What it does | Hints | Typed output |
| --- | --- | --- | --- |
| **`search_emails`** | Search one folder, newest first. `query` matches subject or body; `from:address` / `to:address` match a sender or recipient; the word `OR` (any case) between spaces separates alternatives, e.g. `from:alice@example.com OR invoice`; a phrase in double quotes is searched literally, OR and `from:` included (`"rock or roll"`). Optional `since`/`before` dates and the flag filters `seen`, `answered`, `flagged`, `draft`, `deleted` (`true` = only with the flag, `false` = only without, omit = both) narrow the whole query. Returns headers with flags; `limit` (1-200, default 50) and `offset` page through the matches, and the result says how many matched and which offset comes next | read-only | `messages` (each with `flags` and `unread`), `total`, `nextOffset` while pages remain |
| **`get_email`** | One message in full by UID, with attachment metadata. UIDs are per folder | read-only | `found`, `message` (headers, `cc`, `body`, `attachments`) |
| **`get_email_thread`** | Every message in a conversation, found by the Message-ID of any message in it; bodies are shortened to 200 characters | read-only | `found`, `subject`, `participants`, `lastActivity`, `messages` (`uid`, `preview`, `truncated`) |
| **`get_folders`** | Every folder with its path, flags and special-use role | read-only | `folders` |
| **`send_email`** | Send a message over SMTP immediately; needs `text` or `html` | destructive, open-world | `success`, `messageId` |
| **`create_draft`** | Save a message to Drafts without sending it; the body may be empty | additive | `success`, `uid`, `folder` |
| **`move_email`** | Move one message to another folder (it gets a new UID there) | idempotent | – |
| **`mark_email`** | Add or remove flags: `\Seen`, `\Answered`, `\Flagged`, `\Deleted`, `\Draft` (server keywords such as `\Junk` are accepted too; `\Recent` is refused, the server owns it) | idempotent | – |
| **`delete_email`** | Move one message to the trash, or with `permanent: true` expunge it | destructive | – |
| **`create_directory`** | Create a folder, optionally under an existing `parentPath` | additive | – |

Mail content in tool results is third-party data. `search_emails`, `get_email` and `get_email_thread` say so at the top of their text, and each message body is fenced between `--- BEGIN EMAIL BODY <marker> ---` and `--- END EMAIL BODY <marker> ---` lines with a random marker, so a message cannot pass itself off as instructions by closing the fence early.

**Typed output.** The tools with a "Typed output" entry return [`structuredContent`](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content) that matches the `outputSchema` they declare, next to the same text as before, so a client can read a UID or the next offset without parsing prose. Fields that carry mail content (subjects, display names, bodies, previews, attachment names) are described in the schema as untrusted third-party data. A message that does not exist is `found: false`. A message date is its `Date:` header, else the server's arrival date; when neither is usable it is `null` ("unknown date" in the text) rather than a made-up one. Tools that only acknowledge an action report it through `isError`.

### **Calendar Tools**

- **`get_calendar_events`** - Retrieve events in date range. Recurring events are listed once per occurrence; each event shows its `UID`, and an occurrence of a series shows the series UID plus an `Occurrence:` line with its recurrence id
- **`search_calendar`** - Search events by keyword (same event format)
- **`get_free_busy`** - Check availability for scheduling
- **`create_calendar_event`** - Create an event (summary, start/end, optional description, location, all-day flag, attendees, target calendar) and return its UID. Timed events need a date-time with an explicit offset or `Z` (a date-time without one is read in the time zone of the machine running the server) and are stored in UTC. For all-day events pass dates (`YYYY-MM-DD`); `end` is the last day, inclusive, and can be omitted for a one-day event. Impossible dates such as `2025-02-30` and local times skipped by a daylight-saving change are refused. By default nobody is notified: attendees are only recorded on the event. Only with `sendInvitations: true` (meant for when you explicitly ask to invite people) does your account become the organizer, and mailbox.org may then email invitations to all attendees. The target calendar and the `MAILBOX_CALENDARS` entries are matched exactly, by display name, full URL or last URL segment; a name that matches several calendars is refused. When `MAILBOX_CALENDARS` is set, events can only be created in those calendars, and the first one listed is the default
- **`update_calendar_event`** - Change an event found by its UID: only the fields passed change (an empty `description` or `location` removes it, `attendees` replaces the list and keeps the reply status of those who stay); alarms, recurrence rules and time zones are kept. Times follow the `create_calendar_event` contract; when only `start` is passed the event keeps its length, and values equal to the stored ones count as no change. The write carries the event's ETag (`If-Match`), so a change made elsewhere in the meantime fails with "changed on the server" instead of being overwritten
- **`delete_calendar_event`** - Permanently delete an event found by its UID, also with `If-Match`

**Recurring events.** Update and delete act on the whole series and take the series UID. Changing or deleting a single occurrence is not supported: an occurrence id from the read tools (`UID:2025-06-20` or `UID:2025-06-20T08:00:00.000Z`) is refused with a message naming the series UID (a stored event whose UID merely looks like that, e.g. `holiday:2025-12-25`, is found and changed as usual). Moving a recurring series (start, end, all-day) is refused as well, because times are written in UTC and the series would shift across daylight-saving changes; title, description, location and attendees can be changed.

**No surprise mail (RFC 6638).** mailbox.org sends scheduling mail for events that have an organizer and attendees. These tools avoid that unless you ask for it:
- `update_calendar_event` records new attendees only (`SCHEDULE-AGENT=CLIENT`, no organizer added). With `sendInvitations: true` your account becomes the organizer and the server may email invitations, updates and cancellations.
- A meeting you organize (organizer is your address, or one of the calendar user addresses the server reports, with attendees that are not marked `SCHEDULE-AGENT=CLIENT`) is not changed without `sendInvitations: true` and not deleted without `notifyParticipants: true`, since any change makes the server email the attendees.
- An event is treated as an invitation you received only when your address is among its attendees and the organizer is someone else. Such an event cannot be changed; deleting it sends `Schedule-Reply: F`, asking the server not to send the organizer a decline (with `notifyParticipants: true` the server may send one).
- Any other meeting (an organizer that is neither recognisably you nor someone who invited you, e.g. an alias the server does not report) is handled like one you organize: it is not changed or deleted without the opt-in flag, because the server may email the attendees.

Calendars for update and delete are chosen like for create: exact display name, URL or last URL segment, and only among `MAILBOX_CALENDARS` when that is set. A UID found in several calendars is refused until you name the calendar.

**Read errors.** When a calendar cannot be read, the read tools return an error naming it instead of an empty list or an all-free range (a partial list would show the unreadable calendar's meetings as free time). When the server cannot be reached, recently cached results are still served.

### **Sieve Filter Tools**

Manage email filtering rules using the [Sieve language](https://tools.ietf.org/html/rfc5228) (RFC 5228) through the ManageSieve protocol.

| Tool | What it does | Hints |
| --- | --- | --- |
| **`list_sieve_scripts`** | List the scripts on the server and which one is active | read-only |
| **`get_sieve_script`** | Return the source of one script | read-only |
| **`create_sieve_filter`** | Save a script under a name (replacing one of that name) after the server has checked it; activates it unless `activate: false` | destructive, idempotent |
| **`delete_sieve_script`** | Delete a script; the server refuses to delete the active one | destructive, idempotent |
| **`activate_sieve_script`** | Make one script the active filter; the previous one stays stored but stops running | destructive, idempotent |
| **`check_sieve_script`** | Check a script's syntax without saving it | read-only |
| **`get_sieve_capabilities`** | Show the server's limits and supported Sieve extensions | read-only |

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

### **Prompts**

Prompts are workflows you pick in the client (Claude Desktop lists them as attachable prompts or slash commands). They only write the opening request; the work is done by the tools above, which the client shows and asks you to approve as usual.

- **`draft_reply`** (`uid`, optional `folder`): read one message with `get_email` and save a reply with `create_draft`, never sending it.
- **`summarize_thread`** (`messageId`, optional `folder`): read a conversation with `get_email_thread` and summarise what was decided and what is still open.

Both remind the model that the mail is third-party content.

### **Resources**

- **`mailbox://folders`** (`application/json`): the folder list `get_folders` returns, with path, delimiter, flags and special-use role, for clients that let you attach reference data without a tool call.

### **Server Instructions**

On connect the server sends short `instructions` that clients add to the model's context: folder names differ per account (call `get_folders`), UIDs are only valid in the folder they came from, and `search_emails` returns headers only.

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
  - IPv4/IPv6 (dual-stack) connection is handled by nodemailer: it resolves both address families and falls back to the other one when one is unreachable
- `MAILBOX_SMTP_PORT`: SMTP server port (default: `465`)
  - Must be a valid port number (1-65535)
- `MAILBOX_SMTP_SECURE`: Use TLS encryption (default: `true`)
  - Must be `"true"` or `"false"`
  - Use `true` for port 465 (implicit TLS) and `false` for port 587 (STARTTLS)
  - TLS is always required: with `false` the connection must upgrade via STARTTLS, otherwise it is refused
  - The server certificate is verified, so `MAILBOX_SMTP_HOST` must be a hostname covered by the certificate (e.g. `smtp.mailbox.org`); an IP address fails verification

#### **Optional Calendar Configuration**

- `MAILBOX_CALDAV_URL`: CalDAV server URL (default: `https://dav.mailbox.org/`)
  - Must be a valid URL format
- `MAILBOX_CALENDARS`: Comma-separated list of calendars to access, for reading and writing. Entries match a calendar's exact display name, URL or last URL segment, never a substring; an entry that matches no calendar or several calendars is a configuration error, and the error lists the available calendars as `Display Name (last URL segment)`. Events outside these calendars cannot be read, created, changed or deleted; the first entry is the default calendar for `create_calendar_event`

> **Breaking:** `MAILBOX_CALENDARS` entries now match exactly (display name, URL, or last path segment); substring matches no longer work. An entry such as `work` that used to match `.../work-calendar/` by substring is now refused with a configuration error listing the available calendars; use the display name or last URL segment shown there. This also applies to the `calendar` argument of the calendar tools.

#### **Optional Sieve Configuration**

- `MAILBOX_SIEVE_HOST`: Sieve server host (default: `imap.mailbox.org`)
  - Must be a non-empty string
- `MAILBOX_SIEVE_PORT`: Sieve server port (default: `4190`)
  - Must be a valid port number (1-65535)
- `MAILBOX_SIEVE_SECURE`: How the connection is encrypted (default: `false`)
  - Must be `"true"` or `"false"`
  - `false`: connect in plain text and upgrade with STARTTLS. STARTTLS is
    mandatory: the client refuses to authenticate if the server does not
    offer it or the upgrade fails. This is what the standard ManageSieve
    port `4190` (including mailbox.org) expects.
  - `true`: implicit TLS from the first byte. Only for servers that offer
    ManageSieve on a dedicated TLS port; the standard port `4190` does not
    speak implicit TLS.
  - In both modes the server certificate is always verified.

#### **Optional Cache Configuration**

Cache lifetimes are fixed (searches 5 min, messages 10 min, folder list 15
min). When the server is unreachable, an expired cached copy is served for up
to a day past its lifetime; with no cached copy the tool returns an error.

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

The IMAP pool keeps one connection open while idle. The SMTP pool connects on demand: checking an idle SMTP connection means a full login, so it is opened for a send and closed again once idle for `POOL_IDLE_TIMEOUT_MS`.

#### **Optional Debug Configuration**

- `DEBUG`: Enable debug logging (default: `false`)
  - Must be `"true"` or `"false"`
  - Tool calls are logged with the names and types of their arguments only, never their values, so mail content, recipients and Sieve scripts stay out of the log

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
- **`bun run typecheck`** - Type-check `src/` and `tests/` (`build` covers `src/` only)
- **`bun start`** - Start production server
- **`bun run test`** - Run test suite
- **`bun run test:e2e`** - Run the end-to-end check against a local IMAP server (see [End-to-end checks](#end-to-end-checks))
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

### **End-to-end checks**

The unit tests mock `imapflow` entirely, so they cannot catch protocol-level
regressions: a method that resolves `false` instead of throwing, a search
criterion the server ignores, or a library upgrade that changes envelope
shapes. `tests/e2e/imap-e2e.mjs` drives the **built** server over stdio
against [GreenMail](https://greenmail-mail-test.github.io/greenmail/), which
keeps its mailboxes in memory and holds no real mail. The script refuses to
run unless every host it hands the server (IMAP, SMTP, Sieve, CalDAV) is
`localhost` or `127.0.0.1`, and it does not pass on any `MAILBOX_*` variables
from your shell, so your own mailbox is never touched.

The server only sends mail over TLS and always verifies the certificate, and
GreenMail's built-in certificate is not issued for `127.0.0.1`. So GreenMail
is started with a throwaway test certificate, which the check then trusts:

```bash
# 1. A test certificate for 127.0.0.1 (valid 30 days)
mkdir -p /tmp/greenmail-tls && cd /tmp/greenmail-tls
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \
  -days 30 -subj /CN=localhost -addext subjectAltName=IP:127.0.0.1,DNS:localhost
openssl pkcs12 -export -in cert.pem -inkey key.pem -out greenmail.p12 \
  -passout pass:changeit -name greenmail
cd -

# 2. Start a throwaway IMAP/SMTP server
docker run --rm -p 3143:3143 -p 3465:3465 -p 3993:3993 \
  -v /tmp/greenmail-tls:/certs:ro \
  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=e2e:e2epass@example.com -Dgreenmail.users.login=email -Dgreenmail.tls.keystore.file=/certs/greenmail.p12 -Dgreenmail.tls.keystore.password=changeit -Dgreenmail.tls.key.password=changeit' \
  greenmail/standalone:2.1.3

# 3. Build, then run the checks
bun run build
E2E_CA_FILE=/tmp/greenmail-tls/cert.pem bun run test:e2e
```

GreenMail cannot delete a folder a closed session had open, so the `Trash`
folder the run creates outlives it; a second run against the same container
skips the "no trash folder" case and says so. Restart the container to cover
it again.

It covers folder creation (top-level and nested via `parentPath`) and cache
invalidation, drafts, sending, searching (newest first, flag filters),
fetching a message's addresses and body, flags, threading by `Message-ID`
header, moving, permanent deletion (re-checked from a fresh process so a warm
cache cannot mask it), and soft deletion with and without a trash folder. It
exits non-zero if any check fails. It is not run in CI.

SMTP always goes over GreenMail's SMTPS port (3465). To run IMAP over TLS as
well:

```bash
E2E_CA_FILE=/tmp/greenmail-tls/cert.pem E2E_IMAP_PORT=3993 E2E_IMAP_SECURE=true bun run test:e2e
```

Worth running before merging an upgrade to `imapflow`, `mailparser`,
`nodemailer` or the MCP SDK. `E2E_SERVER=/path/to/dist/main.js` points the
checks at another build, which is handy for comparing two revisions.

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
   - SMTP certificate or TLS errors: use a hostname for `MAILBOX_SMTP_HOST` (not an IP address) and set `MAILBOX_SMTP_SECURE=false` when using port 587 (STARTTLS)

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
