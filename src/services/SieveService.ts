import { Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import {
  type SieveCapabilities,
  type SieveConnection,
  SieveError,
  type SieveResponse,
  type SieveScript,
} from "../types/sieve.types.js";
import { createLogger } from "./Logger.js";

export class SieveService {
  private socket: Socket | TLSSocket | null = null;
  private connected = false;
  private authenticated = false;
  private capabilities: SieveCapabilities | null = null;
  private buffer = "";
  private responseResolvers: Map<
    number,
    {
      resolve: (response: SieveResponse) => void;
      reject: (error: Error) => void;
    }
  > = new Map();
  private commandId = 0;
  private logger = createLogger("SieveService");

  constructor(private config: SieveConnection) {}

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.logger.info(
        "Connecting to ManageSieve server",
        {
          operation: "connect",
          service: "SieveService",
        },
        {
          host: this.config.host,
          port: this.config.port,
          secure: this.config.secure,
        },
      );

      if (this.config.secure) {
        this.socket = tlsConnect({
          host: this.config.host,
          port: this.config.port,
          rejectUnauthorized: true,
        });
      } else {
        this.socket = new Socket();
        this.socket.connect(this.config.port, this.config.host);
      }

      await this.setupSocketHandlers();
      await this.waitForGreeting();

      this.connected = true;

      // Get capabilities
      this.capabilities = await this.getCapabilities();

      await this.logger.info(
        "Successfully connected to ManageSieve server",
        {
          operation: "connect",
          service: "SieveService",
        },
        {
          implementation: this.capabilities.implementation,
          version: this.capabilities.version,
        },
      );
    } catch (error) {
      this.connected = false;
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logger.error(
        "Failed to connect to ManageSieve server",
        {
          operation: "connect",
          service: "SieveService",
        },
        {
          error: errorMsg,
          host: this.config.host,
          port: this.config.port,
        },
      );
      throw new SieveError(
        `Failed to connect to ManageSieve server: ${errorMsg}`,
      );
    }
  }

  async authenticate(): Promise<void> {
    if (!this.connected) {
      throw new SieveError("Not connected to server");
    }

    if (this.authenticated) {
      return;
    }

    try {
      // Check if STARTTLS is available and we're not already using TLS
      if (this.capabilities?.sieveExtensions.includes('STARTTLS') && !this.config.secure) {
        await this.logger.info(
          "Starting TLS upgrade for ManageSieve connection",
          {
            operation: "starttls",
            service: "SieveService",
          },
        );

        const tlsResponse = await this.sendCommand("STARTTLS");
        if (!tlsResponse.success) {
          throw new SieveError(
            `STARTTLS failed: ${tlsResponse.message}`,
            tlsResponse.code,
          );
        }

        // Upgrade the socket to TLS
        await this.upgradeToTLS();
      }

      await this.logger.info(
        "Authenticating with ManageSieve server",
        {
          operation: "authenticate",
          service: "SieveService",
        },
        {
          user: this.config.user,
        },
      );

      // Use PLAIN SASL mechanism (base64 encoded: \0username\0password)
      const authString = `\0${this.config.user}\0${this.config.password}`;
      const authBase64 = Buffer.from(authString).toString("base64");

      const response = await this.sendCommand(
        `AUTHENTICATE "PLAIN" "${authBase64}"`,
      );

      if (!response.success) {
        throw new SieveError(
          `Authentication failed: ${response.message}`,
          response.code,
        );
      }

      this.authenticated = true;

      await this.logger.info(
        "Successfully authenticated with ManageSieve server",
        {
          operation: "authenticate",
          service: "SieveService",
        },
      );
    } catch (error) {
      this.authenticated = false;
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.logger.error(
        "Authentication failed",
        {
          operation: "authenticate",
          service: "SieveService",
        },
        {
          error: errorMsg,
        },
      );
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.connected && this.socket) {
        await this.sendCommand("LOGOUT");
      }
    } catch (error) {
      // Ignore logout errors
    } finally {
      if (this.socket) {
        this.socket.destroy();
        this.socket = null;
      }
      this.connected = false;
      this.authenticated = false;
      this.capabilities = null;
      this.buffer = "";
      this.responseResolvers.clear();
    }
  }

  async listScripts(): Promise<SieveScript[]> {
    await this.ensureAuthenticated();

    const response = await this.sendCommand("LISTSCRIPTS");
    if (!response.success) {
      throw new SieveError(
        `Failed to list scripts: ${response.message}`,
        response.code,
      );
    }

    return this.parseScriptList(response.data);
  }

  async getScript(name: string): Promise<string> {
    await this.ensureAuthenticated();

    const response = await this.sendCommand(`GETSCRIPT "${name}"`);
    if (!response.success) {
      throw new SieveError(
        `Failed to get script '${name}': ${response.message}`,
        response.code,
      );
    }

    return response.data;
  }

  async putScript(name: string, content: string): Promise<void> {
    await this.ensureAuthenticated();

    const response = await this.sendCommand(
      `PUTSCRIPT "${name}" {${content.length}}\r\n${content}`,
    );
    if (!response.success) {
      throw new SieveError(
        `Failed to put script '${name}': ${response.message}`,
        response.code,
      );
    }
  }

  async deleteScript(name: string): Promise<void> {
    await this.ensureAuthenticated();

    const response = await this.sendCommand(`DELETESCRIPT "${name}"`);
    if (!response.success) {
      throw new SieveError(
        `Failed to delete script '${name}': ${response.message}`,
        response.code,
      );
    }
  }

  async setActiveScript(name: string): Promise<void> {
    await this.ensureAuthenticated();

    const response = await this.sendCommand(`SETACTIVE "${name}"`);
    if (!response.success) {
      throw new SieveError(
        `Failed to activate script '${name}': ${response.message}`,
        response.code,
      );
    }
  }

  async checkScript(content: string): Promise<void> {
    await this.ensureAuthenticated();

    const response = await this.sendCommand(
      `CHECKSCRIPT {${content.length}}\r\n${content}`,
    );
    if (!response.success) {
      throw new SieveError(
        `Script validation failed: ${response.message}`,
        response.code,
      );
    }
  }

  getServerCapabilities(): SieveCapabilities | null {
    return this.capabilities;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  private async setupSocketHandlers(): Promise<void> {
    if (!this.socket) {
      throw new SieveError("Socket not initialized");
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new SieveError(`Connection timeout to ${this.config.host}:${this.config.port}`));
      }, 10000);

      this.socket!.on("connect", () => {
        clearTimeout(timeout);
        this.logger.debug(`Socket connected to ${this.config.host}:${this.config.port}`, {
          operation: "socketConnect",
          service: "SieveService",
        });
        resolve();
      });

      this.socket!.on("secureConnect", () => {
        clearTimeout(timeout);
        this.logger.debug(`TLS connection established to ${this.config.host}:${this.config.port}`, {
          operation: "tlsConnect", 
          service: "SieveService",
        });
        resolve();
      });

      this.socket!.on("data", (data: Buffer) => {
        const dataStr = data.toString();
        this.logger.debug(`Received data: ${dataStr.substring(0, 100)}...`, {
          operation: "socketData",
          service: "SieveService",
        });
        this.buffer += dataStr;
        this.processBuffer();
      });

      this.socket!.on("error", (error) => {
        clearTimeout(timeout);
        this.connected = false;
        this.logger.error(`Socket error: ${error.message}`, {
          operation: "socketError",
          service: "SieveService",
        }, {
          host: this.config.host,
          port: this.config.port,
          secure: this.config.secure,
        });
        reject(new SieveError(`Socket error: ${error.message}`));
      });

      this.socket!.on("close", () => {
        this.connected = false;
        this.authenticated = false;
        this.logger.debug("Socket closed", {
          operation: "socketClose",
          service: "SieveService",
        });
      });

      this.socket!.on("timeout", () => {
        clearTimeout(timeout);
        reject(new SieveError(`Socket timeout to ${this.config.host}:${this.config.port}`));
      });
    });
  }

  private async waitForGreeting(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.logger.error("Timeout waiting for server greeting", {
          operation: "waitForGreeting",
          service: "SieveService",
        }, {
          buffer: this.buffer.substring(0, 200),
          bufferLength: this.buffer.length,
        });
        reject(new SieveError("Timeout waiting for server greeting"));
      }, 15000);

      const checkGreeting = () => {
        this.logger.debug(`Checking greeting in buffer: ${this.buffer.substring(0, 100)}...`, {
          operation: "checkGreeting",
          service: "SieveService", 
        });

        const lines = this.buffer.split("\r\n");
        for (const line of lines) {
          if (line.trim().startsWith("OK")) {
            clearTimeout(timeout);
            this.logger.info(`Received server greeting: ${line}`, {
              operation: "greeting",
              service: "SieveService",
            });
            resolve();
            return;
          }
          if (line.trim().startsWith("NO") || line.trim().startsWith("BYE")) {
            clearTimeout(timeout);
            this.logger.error(`Server rejected connection: ${line}`, {
              operation: "greeting",
              service: "SieveService",
            });
            reject(new SieveError(`Server rejected connection: ${line}`));
            return;
          }
        }
      };

      // Check if greeting is already in buffer
      checkGreeting();

      // Set up temporary data handler for greeting only
      let greetingReceived = false;
      const greetingHandler = (data: Buffer) => {
        if (greetingReceived) return;
        
        const dataStr = data.toString();
        this.logger.debug(`Greeting data received: ${dataStr}`, {
          operation: "greetingData",
          service: "SieveService",
        });
        
        this.buffer += dataStr;
        checkGreeting();
        
        if (this.buffer.includes("OK")) {
          greetingReceived = true;
          this.socket!.removeListener("data", greetingHandler);
        }
      };

      this.socket!.on("data", greetingHandler);
    });
  }

  private async getCapabilities(): Promise<SieveCapabilities> {
    const response = await this.sendCommand("CAPABILITY");
    if (!response.success) {
      throw new SieveError(
        `Failed to get capabilities: ${response.message}`,
        response.code,
      );
    }

    return this.parseCapabilities(response.data);
  }

  private async sendCommand(command: string): Promise<SieveResponse> {
    if (!this.socket) {
      throw new SieveError("Not connected to server");
    }

    const id = ++this.commandId;

    return new Promise((resolve, reject) => {
      this.responseResolvers.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        this.responseResolvers.delete(id);
        reject(new SieveError(`Command timeout: ${command}`));
      }, 30000);

      this.socket!.write(`${command}\r\n`);

      // Override resolve to clear timeout
      const originalResolve = resolve;
      resolve = (response) => {
        clearTimeout(timeout);
        originalResolve(response);
      };
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\r\n");

    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      this.processResponseLine(line);
    }

    // Keep the last incomplete line in buffer
    this.buffer = lines[lines.length - 1];
  }

  private processResponseLine(line: string): void {
    // For capabilities and multi-line responses, we need to collect all data
    if (line.startsWith("OK ")) {
      // For capabilities response, include all collected buffer data
      const data = this.buffer.split('\r\n').slice(0, -1).join('\r\n');
      this.resolveCommand({ 
        success: true, 
        message: line.substring(3),
        data: data 
      });
    } else if (line.startsWith("NO ")) {
      this.resolveCommand({
        success: false,
        code: "NO",
        message: line.substring(3),
      });
    } else if (line.startsWith("BYE ")) {
      this.resolveCommand({
        success: false,
        code: "BYE",
        message: line.substring(4),
      });
    }
    // For other lines, they are part of the response data (like capabilities)
  }

  private resolveCommand(response: SieveResponse): void {
    if (this.responseResolvers.size > 0) {
      const entry = this.responseResolvers.entries().next();
      if (entry.value) {
        const [id, resolver] = entry.value;
        this.responseResolvers.delete(id);
        resolver.resolve(response);
      }
    }
  }

  private parseScriptList(data: string): SieveScript[] {
    // Parse LISTSCRIPTS response format
    const scripts: SieveScript[] = [];
    const lines = data.split("\r\n");

    for (const line of lines) {
      const match = line.match(/^"([^"]+)"\s*(ACTIVE)?/);
      if (match) {
        scripts.push({
          name: match[1],
          content: "",
          active: !!match[2],
        });
      }
    }

    return scripts;
  }

  private parseCapabilities(data: string): SieveCapabilities {
    const capabilities: SieveCapabilities = {
      implementation: "",
      version: "",
      saslMechanisms: [],
      sieveExtensions: [],
    };

    const lines = data.split("\r\n");

    for (const line of lines) {
      if (line.startsWith('"IMPLEMENTATION"')) {
        capabilities.implementation = line.match(/"([^"]+)"/)?.[1] || "";
      } else if (line.startsWith('"VERSION"')) {
        capabilities.version = line.match(/"([^"]+)"/)?.[1] || "";
      } else if (line.startsWith('"SASL"')) {
        capabilities.saslMechanisms =
          line.match(/"([^"]+)"/)?.[1]?.split(" ") || [];
      } else if (line.startsWith('"SIEVE"')) {
        capabilities.sieveExtensions =
          line.match(/"([^"]+)"/)?.[1]?.split(" ") || [];
      } else if (line === '"STARTTLS"') {
        // STARTTLS is advertised as a single capability
        capabilities.sieveExtensions.push("STARTTLS");
      }
    }

    return capabilities;
  }

  private async upgradeToTLS(): Promise<void> {
    if (!this.socket) {
      throw new SieveError("Socket not available for TLS upgrade");
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new SieveError("TLS upgrade timeout"));
      }, 10000);

      try {
        // Wrap the existing socket with TLS
        const tlsSocket = tlsConnect({
          socket: this.socket as Socket,
          rejectUnauthorized: true,
        });

        tlsSocket.on("secureConnect", () => {
          clearTimeout(timeout);
          this.socket = tlsSocket;
          
          // Clear the buffer after TLS upgrade to avoid confusion with old data
          this.buffer = "";
          
          // Re-setup data and error handlers for the new TLS socket
          tlsSocket.on("data", (data: Buffer) => {
            const dataStr = data.toString();
            this.logger.debug(`TLS data received: ${dataStr.substring(0, 100)}...`, {
              operation: "tlsData",
              service: "SieveService",
            });
            this.buffer += dataStr;
            this.processBuffer();
          });

          tlsSocket.on("error", (error) => {
            this.connected = false;
            this.logger.error(`TLS socket error: ${error.message}`, {
              operation: "tlsSocketError",
              service: "SieveService",
            });
          });

          this.logger.info("TLS upgrade successful", {
            operation: "upgradeToTLS",
            service: "SieveService",
          });
          resolve();
        });

        tlsSocket.on("error", (error) => {
          clearTimeout(timeout);
          reject(new SieveError(`TLS upgrade failed: ${error.message}`));
        });

      } catch (error) {
        clearTimeout(timeout);
        reject(new SieveError(`TLS upgrade error: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
    if (!this.authenticated) {
      await this.authenticate();
    }
  }
}
