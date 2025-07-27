import { afterAll, beforeAll } from "vitest";

// Store original console methods
const originalConsole = {
  error: console.error,
  warn: console.warn,
  log: console.log,
};

beforeAll(() => {
  // Suppress console output during tests to reduce noise from expected errors
  console.error = (...args: unknown[]) => {
    const message = args.join(" ");
    // Only suppress known expected error messages
    if (
      message.includes("Failed to send email:") ||
      message.includes("connection validation failed:") ||
      message.includes("connection verification failed:") ||
      message.includes("Error parsing iCal data:") ||
      message.includes("Error during IMAP logout:") ||
      message.includes("Error closing SMTP connection:") ||
      message.includes("Error fetching events from calendar") ||
      message.includes("Calendar discovery failed:") ||
      message.includes("Attempting to release unknown connection") ||
      message.includes("Error searching emails:") ||
      message.includes("Error fetching email UID") ||
      message.includes("Connection creation failed") ||
      message.includes("Error fetching folders:") ||
      message.includes(
        "Failed to create minimum connection during health check:",
      )
    ) {
      return; // Suppress this error
    }
    // Otherwise log normally
    originalConsole.error(...args);
  };

  console.warn = (...args: unknown[]) => {
    const message = args.join(" ");
    // Suppress known expected warning messages
    if (
      message.includes("Attempting to release unknown connection") ||
      message.includes("connection validation failed:") ||
      message.includes("Error during IMAP logout:") ||
      message.includes("Error closing SMTP connection:") ||
      message.includes("Connection creation failed") ||
      message.includes(
        "Failed to create minimum connection during health check",
      )
    ) {
      return; // Suppress this warning
    }
    // Otherwise log normally
    originalConsole.warn(...args);
  };

  console.log = (...args: unknown[]) => {
    const message = args.join(" ");
    // Suppress known expected log messages from retry logic and service operations
    if (
      message.includes("Connection creation failed (attempt") ||
      message.includes("retrying in") ||
      message.includes("Found offline search results for:") ||
      message.includes("No offline search results found for:") ||
      message.includes("Found offline email UID") ||
      message.includes("No offline email found for UID") ||
      message.includes("Found offline folders list") ||
      message.includes("No offline folders found, returning default folders") ||
      message.includes(
        "Returning stale cached data due to connection failure",
      ) ||
      message.includes("Returning stale cached email UID") ||
      message.includes(
        "Returning stale cached folders due to connection failure",
      ) ||
      message.includes(
        "No cached data available, returning empty results due to connection failure",
      ) ||
      (message.includes("Email UID") &&
        message.includes("not available due to connection failure")) ||
      message.includes("Returning default folders due to connection failure")
    ) {
      return; // Suppress this log
    }
    // Otherwise log normally
    originalConsole.log(...args);
  };
});

afterAll(() => {
  // Restore original console methods
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.log = originalConsole.log;
});
