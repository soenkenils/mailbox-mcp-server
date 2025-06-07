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

- npm run build: Build the project
- npm test: Run the test suite
- npm run check: Run both linting and formatting

## Workflow

- Be sure to run tests and formatting when you’re done making a series of code changes
- Prefer running single tests, and not the whole test suite, for performance
