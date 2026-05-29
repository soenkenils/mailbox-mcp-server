import { promises as dns } from "node:dns";
import net from "node:net";

const isIpLiteral = (h: string): boolean => net.isIP(h) !== 0;

/**
 * Happy-Eyeballs-Hostauswahl fuer nodemailer.
 *
 * Problem: nodemailer macht KEIN Happy-Eyeballs. Es resolved den Hostnamen und
 * verbindet zu EINER Adress-Family. Auf manchen Setups ist IPv4 zu mailbox.org
 * tot (ETIMEDOUT, nur via VPN offen), auf anderen IPv6. Je nach VPN-Zustand
 * wechselt die erreichbare Family -> kein fixer Host funktioniert in beiden Faellen.
 *
 * Loesung: A- und AAAA-Records aufloesen, parallel TCP-Connects rennen lassen,
 * erste erreichbare Adresse gewinnt. Ergebnis wird als IP-Literal zurueckgegeben
 * und als nodemailer-`host` benutzt; SNI/Zert laeuft ueber `tls.servername`.
 *
 * @returns erreichbares IP-Literal, oder den Original-Host als Fallback wenn
 *          weder A noch AAAA erreichbar sind (dann soll nodemailer es selbst versuchen).
 */
export async function resolveReachableHost(
  host: string,
  port: number,
  timeoutMs = 8000,
): Promise<string> {
  // Bereits ein IP-Literal -> nichts aufzuloesen.
  if (isIpLiteral(host)) return host;

  const [v4, v6] = await Promise.all([
    dns.resolve4(host).catch(() => [] as string[]),
    dns.resolve6(host).catch(() => [] as string[]),
  ]);

  // IPv6 zuerst probieren (auf diesem Rechner ohne VPN die funktionierende Route),
  // dann IPv4. Beide parallel; erster erfolgreicher Connect gewinnt.
  const candidates = [...v6, ...v4];
  if (candidates.length === 0) return host;

  return new Promise<string>(resolve => {
    let settled = false;
    let pending = candidates.length;
    const sockets: net.Socket[] = [];

    const cleanup = (winner: string | null) => {
      if (settled) return;
      settled = true;
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
      }
      resolve(winner ?? host);
    };

    for (const ip of candidates) {
      const s = net.connect({ host: ip, port, timeout: timeoutMs });
      sockets.push(s);
      s.once("connect", () => cleanup(ip));
      const onFail = () => {
        pending -= 1;
        if (pending === 0) cleanup(null); // keiner erreichbar -> Original-Host
      };
      s.once("timeout", onFail);
      s.once("error", onFail);
    }
  });
}
