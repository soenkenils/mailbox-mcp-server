import { promises as dns } from "node:dns";
import net from "node:net";

export const isIpLiteral = (host: string): boolean => net.isIP(host) !== 0;

export type HostResolver = Pick<typeof dns, "resolve4" | "resolve6">;

/**
 * Pick a reachable address for a host (simplified Happy Eyeballs).
 *
 * nodemailer resolves the host itself and connects to a single address
 * family, IPv4 first. On networks where that family is unreachable (for
 * example IPv4 blocked outside a VPN, or IPv6 broken behind one) every send
 * fails with ETIMEDOUT although the other family works. smtp.mailbox.org
 * publishes both A and AAAA records.
 *
 * This resolves A and AAAA records, races TCP connects to all addresses and
 * returns the first address that accepts a connection. The caller connects
 * to that IP literal and passes the original hostname as `tls.servername`,
 * so SNI and certificate checks still use the hostname.
 *
 * @returns a reachable IP literal, or `host` unchanged if it already is an IP
 *          literal, has no DNS records, or no address could be reached
 *          (nodemailer then tries on its own and reports its usual error)
 */
export async function resolveReachableHost(
  host: string,
  port: number,
  timeoutMs = 8000,
  resolver: HostResolver = dns,
): Promise<string> {
  if (isIpLiteral(host)) {
    return host;
  }

  const [v4, v6] = await Promise.all([
    resolver.resolve4(host).catch(() => [] as string[]),
    resolver.resolve6(host).catch(() => [] as string[]),
  ]);

  const candidates = [...v6, ...v4];
  if (candidates.length === 0) {
    return host;
  }

  return new Promise<string>(resolve => {
    let settled = false;
    let pending = candidates.length;
    const sockets: net.Socket[] = [];

    const finish = (winner: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      resolve(winner ?? host);
    };

    for (const ip of candidates) {
      const socket = net.connect({ host: ip, port, timeout: timeoutMs });
      sockets.push(socket);

      let failed = false;
      const onFail = () => {
        // A socket can report "timeout" and later "error": count it once,
        // otherwise the race ends early while another address still connects
        if (failed) {
          return;
        }
        failed = true;
        socket.destroy();
        pending -= 1;
        if (pending === 0) {
          finish(null);
        }
      };

      socket.once("connect", () => finish(ip));
      socket.once("timeout", onFail);
      // Keep listening: an "error" without a listener would crash the process
      socket.on("error", onFail);
    }
  });
}
