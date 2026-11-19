# CLAUDE.md

ALWAYS verify your changes by running the tests with `bun run test`!

## Project Overview

This is a Model Context Protocol (MCP) server for mailbox.org integration, providing:

- IMAP email access and management
- SMTP email sending
- CalDAV calendar operations
- Sieve email filter management (ManageSieve)
- MCP prompts and resources on top of the email tools

Built with TypeScript and Bun (install, build, test); the built server runs on
Node.js 20+. It runs locally over stdio (Claude Desktop, Claude Code) or hosted
over Streamable HTTP with OAuth (see README → Hosted Mode).

## Architecture

### Entry Point

- `src/main.ts` - loads config (`src/config/config.ts`, valibot-validated env
  vars), builds the shared services, and serves them over stdio or HTTP.
  `createProtocolServer` builds a protocol server bound to those services; HTTP
  mode creates a fresh one per request. `SERVER_INSTRUCTIONS` is the text sent
  to clients on connect

### Core Services

- **EmailService** (`src/services/EmailService.ts`) - Email fetching, searching, folder management, drafts, flags, moves, deletes (IMAP via imapflow)
- **SmtpService** (`src/services/SmtpService.ts`) - Email sending (nodemailer)
- **CalendarService** (`src/services/CalendarService.ts`) - CalDAV reads and writes (tsdav, ical.js).
  Writes fold iCalendar lines at 75 octets, check the server's HTTP status
  (tsdav does not throw on 4xx/5xx), send `If-Match` with the event's ETag,
  and never ask the server to send invitations unless the caller passes
  `sendInvitations: true` (or `notifyParticipants: true` on delete)
- **SieveService** (`src/services/SieveService.ts`) - ManageSieve client on
  `node:net`/`node:tls`, one connection per tool call; STARTTLS is mandatory
  unless `MAILBOX_SIEVE_SECURE=true` (implicit TLS)
- **MemoryCache** (`src/services/LocalCache.ts`) - in-memory cache with fixed
  per-call TTLs; `src/utils/cacheFallback.ts` serves a stale copy on
  connection errors
- **Logger** (`src/services/Logger.ts`) - structured logs to stderr plus MCP
  logging notifications

### Tools, Prompts, Resources

- `src/tools/emailTools.ts`, `calendarTools.ts`, `sieveTools.ts` - tool
  definitions and handlers
- `src/tools/emailPrompts.ts` - `draft_reply`, `summarize_thread`
- `src/tools/emailResources.ts` - `mailbox://folders`
- `src/validation/schemas.ts` - valibot schemas for tool arguments;
  `src/utils/toolArgs.ts` drops undeclared arguments and summarises arguments
  for logs (names and types only)

### Transports

- **stdio** (default) - one long-lived protocol server, launched locally by the client
- **HTTP** (`MCP_TRANSPORT=http`, `src/transport/`) - stateless Streamable HTTP on `POST /mcp` with a fresh protocol server per request sharing the same services; `auth.ts` checks the bearer token in constant time, `diagnostics.ts` describes requests for logs without credentials. Never log tokens, `Authorization` values or OAuth codes
- **OAuth** (`src/transport/oauth/`, enabled by `PUBLIC_URL`) - stateless single-user authorization server: `tokens.ts` signs all OAuth state with a key derived from `MCP_AUTH_TOKEN`, `redirectPolicy.ts` is the redirect allowlist, `provider.ts` the consent form and grants, `router.ts` the Express endpoints (the SDK v2 no longer ships them)

### Connection Management

- **ConnectionPool** (`src/services/ConnectionPool.ts`) - generic pool base:
  reuse, health checks, retries with backoff, idle cleanup
- **ImapConnectionPool** - folder-aware IMAP pool, health-checked with NOOP;
  keeps `POOL_MIN_CONNECTIONS` open (1 in stdio, 0 in http mode)
- **SmtpConnectionPool** - connects on demand; requires TLS and verifies certificates
- **CircuitBreaker** (`src/services/CircuitBreaker.ts`) - guards CalDAV
  requests (CalDAV has no pool)

### Security

- Credentials come from environment variables only; the server never reads `.env` itself
- Never log sensitive data (passwords, tokens, email content, Sieve scripts)
- Mail content in tool results is untrusted third-party data and is fenced with a random marker
- App passwords are recommended for mailbox.org

## Code Style

### Language Features

- ES modules with destructured imports, `.js` extensions on relative imports
- Double quotes, 2 spaces indentation, semicolons (enforced by Biome)
- Arrow functions preferred
- async/await over promises
- Object/array destructuring where appropriate

### Patterns

- Dependency injection for services (constructor parameters)
- Error handling with try-catch and custom error types (`src/types/errors.ts`)
- Logging via the Logger (`src/services/Logger.ts`)
- Type-safe interfaces for all data structures (`src/types/`)

### Naming Conventions

- PascalCase for classes and interfaces
- camelCase for variables, functions, and methods
- SCREAMING_SNAKE_CASE for constants
- Descriptive names over abbreviations

## Development Commands

### Running & Building

- `bun run dev` - Start the server from source with `tsx watch`
- `bun run build` - Compile `src/` to `dist/`
- `bun run start` - Run `node dist/main.js`
- `bun run typecheck` - Type-check `src/` **and** `tests/` (the `build`
  script only covers `src/`, since `tsconfig.json` excludes tests)

### Testing

- `bun run test` - Run all tests once (vitest)
- `bun run test:watch` - Run tests in watch mode
- `bun run test:coverage` - Run tests with coverage; fails below the
  thresholds in `vitest.config.ts` (never lower them)
- `bun run test:e2e` - Run `tests/e2e/imap-e2e.mjs` against a local GreenMail
  container (see README → End-to-end checks). The unit tests mock `imapflow`,
  so only this catches protocol-level regressions; run it when changing
  IMAP/SMTP behaviour or upgrading those libraries. It refuses to run unless
  every host points at localhost/127.0.0.1. Not run in CI.

### Code Quality

- `bun run check` - Check linting and formatting (read-only, as run in CI)
- `bun run fix` - Auto-fix what `check` reports (writes files)
- `bun run format` / `bun run lint` - Biome format (writes) / lint only

### CI

`.github/workflows/ci.yml` runs: `bun install --frozen-lockfile`,
`bun audit --audit-level=high` (ignores listed with reasons in the workflow),
`bun run check`, `bun run build`, `bun run typecheck`, `bun run test:coverage`.

## Workflow

### Test-Driven Development

1. Write a failing test first
2. Implement minimal code to pass the test
3. Refactor and improve
4. Run full test suite to ensure no regressions

### Making Changes

1. Create a feature branch from `main`
2. Write tests for new functionality
3. Implement the feature
4. Run `bun run fix` to auto-fix, then `bun run check` to verify, before committing
5. Ensure `bun run typecheck` and `bun run test` pass
6. Create PR with descriptive commit message

### Performance Tips

- Use `bun run test -t "test name"` to run single tests during development
- IMAP connections are reused across operations

## Testing Guidelines

### Unit Tests

- Located in `tests/` (shared helpers in `tests/helpers/`, data in `tests/fixtures/`)
- Mock external dependencies (imapflow, nodemailer, tsdav); ManageSieve tests use a fake server on a local socket
- Test error cases and edge conditions
- Use descriptive test names: `should do X when Y`

### Integration Tests

- `tests/integration.test.ts` wires the real services together over mocked clients
- Use test fixtures for sample data
- Clean up resources after tests (connections, timers)

### Coverage Goals

- Aim for >80% coverage on service classes
- 100% coverage on critical paths (authentication, email sending)
- Don't sacrifice test quality for coverage numbers

## Common Tasks

### Adding a New MCP Tool

1. Add the definition to the module's tool list (`createEmailTools` in `src/tools/emailTools.ts`, `createCalendarTools` in `src/tools/calendarTools.ts`, `getSieveTools` in `src/tools/sieveTools.ts`) with `annotations` (a human `title` plus `readOnlyHint`, and for writes `destructiveHint`, `idempotentHint`, `openWorldHint`), an `inputSchema` closed with `additionalProperties: false`, and an `outputSchema` only when the result carries data worth parsing
2. Implement the handler case (usually delegates to a service); return `structuredContent` matching the `outputSchema`, fence third-party mail content, and log arguments only through `summarizeArgs` (`src/utils/toolArgs.ts`)
3. Add tests; `tests/toolContract.test.ts` checks annotations, closed schemas, that undeclared arguments are dropped, and structured output for every email, calendar and Sieve tool automatically
4. Update the tool table in README.md

### Adding a New Service Method

1. Add method signature to service class
2. Write unit tests for the method
3. Implement the method
4. Update dependent code if needed

### Adding a Configuration Variable

1. Add it to `EnvSchema` and `loadConfig` in `src/config/config.ts`, with a test in `tests/config.test.ts`
2. Document it in README.md (Configuration) and `.env.example`

### Debugging Connection Issues

- Check the `MAILBOX_*` variables (hosts and ports below)
- Set `DEBUG=true` for debug-level logs on stderr
- Run the server under the MCP Inspector (see README → Debugging with the MCP Inspector)

## Dependencies

### Key Libraries

- `@modelcontextprotocol/server` / `node` / `core` - MCP SDK v2
- `imapflow` - IMAP client
- `nodemailer` - SMTP email sending
- `tsdav` + `ical.js` - CalDAV and iCalendar
- `mailparser` - message parsing
- `valibot` - config and tool argument validation
- `express`, `cors`, `express-rate-limit` - OAuth endpoints in http mode

### Development Tools

- `bun` - package manager, script runner
- `vitest` - unit testing framework
- `@biomejs/biome` - linting and formatting
- `typescript` - type checking and compilation
- `tsx` - runs sources in `bun run dev`

## Environment Setup

### Required Variables

Create a `.env` file (see `.env.example` for every option) with:

```env
MAILBOX_EMAIL=your-email@mailbox.org
MAILBOX_PASSWORD=your-app-password
```

### Optional Configuration

All via environment variables, validated at startup in `src/config/config.ts`:

- `MAILBOX_IMAP_*`, `MAILBOX_SMTP_*`, `MAILBOX_CALDAV_URL`, `MAILBOX_CALENDARS`, `MAILBOX_SIEVE_*` - server endpoints
- `POOL_*` - connection pool sizes and timeouts (`POOL_MAX_CONNECTIONS` defaults to 3)
- `CACHE_*_TTL` - cache lifetimes per operation; `CACHE_MAX_SIZE`, `CACHE_CLEANUP_INTERVAL` - cache limits
- `MCP_TRANSPORT`, `PORT`, `MCP_AUTH_TOKEN`, `PUBLIC_URL`, `OAUTH_ALLOWED_REDIRECT_HOSTS` - hosted mode
- `DEBUG` - debug logging

### Mailbox.org Server Defaults

- **IMAP**: imap.mailbox.org:993 (TLS)
- **SMTP**: smtp.mailbox.org:465 (TLS), or :587 with `MAILBOX_SMTP_SECURE=false` (STARTTLS)
- **CalDAV**: https://dav.mailbox.org/
- **ManageSieve**: imap.mailbox.org:4190 (STARTTLS)

## Documentation

- `README.md` - Project overview, tools, configuration, hosted mode

## Troubleshooting

### Tests Failing

- Run `bun install` to ensure dependencies are up to date
- Check for TypeScript errors with `bun run typecheck` (covers tests too)
- Verify test mocks are properly configured

### Connection Errors

- Verify credentials in `.env` file
- Check internet connectivity
- Ensure mailbox.org services are accessible
- Try regenerating the app password if authentication fails

### Build Issues

- Clear `dist/` directory and rebuild
- Check TypeScript version compatibility
- Verify all imports use correct paths with `.js` extensions
