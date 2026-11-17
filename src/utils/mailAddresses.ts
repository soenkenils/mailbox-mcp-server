type Address = { name?: string; address: string };

/**
 * Addresses as objects, never a "name <address>" string: nodemailer parses
 * strings, so a crafted name could add recipients.
 */
export const toMailAddresses = (
  addresses: Address[],
): Array<{ name: string; address: string }> =>
  addresses.map(({ name, address }) => ({ name: name ?? "", address }));
