#!/usr/bin/env tsx

import { createImapService } from '../src/services/ImapServiceFactory';
import { getConfig } from '../src/config';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

async function main() {
  try {
    console.log('Starting IMAP test...');

    // Get configuration from environment variables
    const config = getConfig();
    console.log("Using configuration:", {
      host: config.host,
      port: config.port,
      user: config.user
    });

    console.log('Connecting to IMAP server...');
    const imapService = createImapService(config);

    // Connect to the IMAP server
    await imapService.connect();
    console.log('Connected to IMAP server');

    // List available folders
    console.log('\nListing folders...');
    const folders = await imapService.listFolders();
    console.log('Available folders:');
    folders.forEach(folder => {
      console.log(`- ${folder.name} (${folder.delimiter})`);
    });

    // Search for emails in the INBOX
    console.log('\nSearching for recent emails in INBOX...');
    const emails = await imapService.searchEmails({
      folder: 'INBOX',
      limit: 5,
    });

    console.log(`\nFound ${emails.length} emails in INBOX:`);
    emails.forEach((email, index) => {
      console.log(`\nEmail ${index + 1}:`);
      console.log(`  Subject: ${email.headers.subject || '(No subject)'}`);
      console.log(`  From: ${email.headers.from?.[0]?.address || 'Unknown'}`);
      console.log(`  Date: ${email.headers.date.toISOString()}`);
      console.log(`  Snippet: ${email.text?.substring(0, 100)}...`);
      console.log(`  Has attachments: ${email.hasAttachments ? 'Yes' : 'No'}`);
    });

    // Get details of the first email
    if (emails.length > 0) {
      const firstEmail = emails[0];
      console.log(`\nGetting details for email: ${firstEmail.headers.subject || '(No subject)'}`);

      const emailDetails = await imapService.getEmail(firstEmail.uid, 'INBOX');
      if (emailDetails) {
        console.log('\nEmail details:');
        console.log('--- Headers ---');
        console.log(`Message ID: ${emailDetails.headers.messageId}`);
        console.log(`Subject: ${emailDetails.headers.subject || '(No subject)'}`);
        console.log(`From: ${emailDetails.headers.from?.[0]?.name || ''} <${emailDetails.headers.from?.[0]?.address || 'unknown'}>`);
        console.log(`To: ${emailDetails.headers.to?.map(a => a.address).join(', ') || ''}`);
        console.log(`Date: ${emailDetails.headers.date.toISOString()}`);
        console.log('--- Content ---');
        console.log(emailDetails.text?.substring(0, 500) + (emailDetails.text && emailDetails.text.length > 500 ? '...' : ''));

        if (emailDetails.attachments.length > 0) {
          console.log('\nAttachments:');
          emailDetails.attachments.forEach((att, i) => {
            console.log(`  ${i + 1}. ${att.filename} (${att.contentType}, ${att.size} bytes)`);
          });
        }
      }
    }

    // Disconnect
    await imapService.disconnect();
    console.log('\nDisconnected from IMAP server');

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run the main function
main();
