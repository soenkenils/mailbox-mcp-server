import { beforeAll, afterAll } from 'vitest';

// Store original console methods
const originalConsole = {
  error: console.error,
  warn: console.warn,
  log: console.log,
};

beforeAll(() => {
  // Suppress console output during tests to reduce noise from expected errors
  console.error = (...args: any[]) => {
    const message = args.join(' ');
    // Only suppress known expected error messages
    if (message.includes('Failed to send email:') ||
        message.includes('connection validation failed:') ||
        message.includes('connection verification failed:') ||
        message.includes('Error parsing iCal data:') ||
        message.includes('Error during IMAP logout:') ||
        message.includes('Error closing SMTP connection:') ||
        message.includes('Error fetching events from calendar') ||
        message.includes('Calendar discovery failed:') ||
        message.includes('Attempting to release unknown connection')) {
      return; // Suppress this error
    }
    // Otherwise log normally
    originalConsole.error(...args);
  };

  console.warn = (...args: any[]) => {
    const message = args.join(' ');
    // Suppress known expected warning messages
    if (message.includes('Attempting to release unknown connection') ||
        message.includes('connection validation failed:') ||
        message.includes('Error during IMAP logout:') ||
        message.includes('Error closing SMTP connection:')) {
      return; // Suppress this warning
    }
    // Otherwise log normally
    originalConsole.warn(...args);
  };
});

afterAll(() => {
  // Restore original console methods
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.log = originalConsole.log;
});