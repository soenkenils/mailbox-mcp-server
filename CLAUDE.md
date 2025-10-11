# CLAUDE.md

## Project Overview

This is a Model Context Protocol (MCP) server for mailbox.org integration, providing:
- IMAP email access and management
- SMTP email sending
- CalDAV calendar operations
- Sieve email filter management

Built with TypeScript and Bun runtime, designed to be used with Claude Desktop.

## Architecture

### Core Services

- **ImapService** (`src/services/ImapService.ts`) - Email fetching, searching, folder management
- **SmtpService** (`src/services/SmtpService.ts`) - Email sending with attachments
- **CalendarService** (`src/services/CalendarService.ts`) - CalDAV operations for events
- **SieveService** (`src/services/SieveService.ts`) - Email filter script management

### Connection Management

- **ConnectionPool** (`src/services/ConnectionPool.ts`) - Manages persistent IMAP connections
- Implements connection reuse, health checks, and automatic cleanup
- Configurable pool size and connection timeouts
- Graceful degradation on connection failures

### Security

- Credentials stored in environment variables (`.env` file)
- Never log sensitive data (passwords, tokens, email content)
- App passwords recommended for mailbox.org (see `APP_PASSWORDS.md`)
- Password validation: 10+ chars for standard, 6+ for app passwords

## Code Style

### Language Features

- ES modules with destructured imports
- Double quotes, 2 spaces indentation, semicolons
- Arrow functions preferred
- async/await over promises
- Object/array destructuring where appropriate

### Patterns

- Dependency injection for services (constructor parameters)
- Error handling with try-catch and custom error messages
- Logging via Logger utility (see `src/utils/logger.ts`)
- Type-safe interfaces for all data structures

### Naming Conventions

- PascalCase for classes and interfaces
- camelCase for variables, functions, and methods
- SCREAMING_SNAKE_CASE for constants
- Descriptive names over abbreviations

## Development Commands

### Running & Building

- `bun dev` - Start development server with file watching
- `bun run build` - Build TypeScript to JavaScript

### Testing

- `bun run test` - Run all tests (using vitest)
- `bun run test:watch` - Run tests in watch mode
- `bun run test:coverage` - Run tests with coverage report
- `bun run test:ui` - Run tests with interactive UI

### Code Quality

- `bun run check` - Run linting and formatting checks
- `bun run format` - Auto-format code with Biome

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
4. Run `bun run check` before committing
5. Ensure all tests pass with `bun run test`
6. Create PR with descriptive commit message

### Performance Tips

- Use `bun run test -t "test name"` to run single tests during development
- Connection pool warmup happens automatically
- IMAP connections are reused across operations

## Testing Guidelines

### Unit Tests

- Located in `__tests__` directories next to source files
- Mock external dependencies (IMAP, SMTP, CalDAV clients)
- Test error cases and edge conditions
- Use descriptive test names: `should do X when Y`

### Integration Tests

- Test actual protocol interactions when needed
- Use test fixtures for sample data
- Clean up resources after tests (connections, temp files)

### Coverage Goals

- Aim for >80% coverage on service classes
- 100% coverage on critical paths (authentication, email sending)
- Don't sacrifice test quality for coverage numbers

## Common Tasks

### Adding a New MCP Tool

1. Define tool schema in `src/index.ts` (`server.tool()`)
2. Implement handler logic (usually delegates to service)
3. Add tests for the tool handler
4. Update documentation

### Adding a New Service Method

1. Add method signature to service class
2. Write unit tests for the method
3. Implement the method
4. Update dependent code if needed

### Debugging Connection Issues

- Check `.env` file for correct credentials
- Verify mailbox.org server addresses (see `APP_PASSWORDS.md`)
- Enable debug logging in ConnectionPool
- Check connection pool health status

## Dependencies

### Key Libraries

- `imapflow` - Modern IMAP client
- `nodemailer` - SMTP email sending
- `tsdav` - CalDAV client for calendar operations
- `sieve` - Sieve email filter parser (custom fork)

### Development Tools

- `bun` - JavaScript runtime and package manager
- `vitest` - Fast unit testing framework
- `@biomejs/biome` - Linting and formatting
- `typescript` - Type checking and compilation

## Environment Setup

### Required Variables

Create a `.env` file with:

```env
MAILBOX_EMAIL=your-email@mailbox.org
MAILBOX_PASSWORD=your-app-password
```

### Optional Configuration

- Connection pool settings in `ConnectionPool` constructor
- Logger level in `src/utils/logger.ts`
- MCP server name and version in `package.json`

## Documentation

- `README.md` - Project overview and setup instructions
- `APP_PASSWORDS.md` - Mailbox.org app password guide
- `SIEVE.md` - Sieve email filter management guide
- `docs/` - Additional protocol documentation (IMAP, CalDAV)

## Troubleshooting

### Tests Failing

- Run `bun install` to ensure dependencies are up to date
- Check for TypeScript errors with `bun run build`
- Verify test mocks are properly configured

### Connection Errors

- Verify credentials in `.env` file
- Check internet connectivity
- Ensure mailbox.org services are accessible
- Try regenerating app password if authentication fails

### Build Issues

- Clear `dist/` directory and rebuild
- Check TypeScript version compatibility
- Verify all imports use correct paths
