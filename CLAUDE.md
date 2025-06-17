# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Coding style

- Use ES modules (import/export) syntax, not CommonJS (require)
- Destructure imports when possible (eg. import { foo } from 'bar')
- Write JavaScript and TypeScript code with double quotes
- Use 2 spaces for indentation
- Use semicolons at the end of statements
- Use destructuring for objects and arrays
- Use arrow functions for callbacks
- Use async/await for asynchronous code

## Tools

- Use Biom for formatting and linting JavaScript and TypeScript code
- Use vitest for testing JavaScript and TypeScript code
- Use Git for version control
- Use GitHub for hosting the code repository

## Bash commands

### Development
- pnpm run dev: Start development server with file watching
- pnpm run build: Build TypeScript to JavaScript
- pnpm run start: Start the built application

### Testing
- pnpm test: Run vitest test suite
- pnpm run test:watch: Run tests in watch mode
- pnpm run test:imap: Run IMAP integration test

### Code Quality
- pnpm run check: Run Biome linting and formatting (writes fixes)
- pnpm run lint: Run Biome linting only
- pnpm run format: Format code with Biome

## Workflow

- Be sure to run tests and formatting when you’re done making a series of code changes
- Prefer running single tests, and not the whole test suite, for performance
