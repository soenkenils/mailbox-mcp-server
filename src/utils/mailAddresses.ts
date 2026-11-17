type Address = { name?: string; address: string };

/**
 * The From identity for mail written as this account. Sent mail and drafts
 * share it, so a draft shows the sender it will have once sent.
 */
export const senderFor = (account: string): Address => ({
  name: account
    .split("@")[0]
    .split(/[._-]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" "),
  address: account,
});

/**
 * Addresses as objects, never a "name <address>" string: nodemailer parses
 * strings, so a crafted name could add recipients.
 */
export const toMailAddresses = (
  addresses: Address[],
): Array<{ name: string; address: string }> =>
  addresses.map(({ name, address }) => ({ name: name ?? "", address }));
