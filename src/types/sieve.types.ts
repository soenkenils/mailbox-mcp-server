export interface SieveConnection {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

export interface SieveScript {
  name: string;
  content: string;
  active: boolean;
  size?: number;
}

export interface SieveCapabilities {
  implementation: string;
  version: string;
  saslMechanisms: string[];
  sieveExtensions: string[];
  maxRedirects?: number;
  maxScriptSize?: number;
  maxScriptName?: number;
}

export interface SieveResponse {
  success: boolean;
  code?: string;
  message?: string;
  data?: unknown;
}

export interface FilterCondition {
  type: "header" | "address" | "envelope" | "body" | "size" | "date";
  field?: string;
  comparator: "is" | "contains" | "matches" | "over" | "under" | "regex";
  values: string[];
  modifier?: "not" | "all" | "domain" | "localpart";
}

export interface FilterAction {
  type:
    | "fileinto"
    | "redirect"
    | "discard"
    | "keep"
    | "stop"
    | "reject"
    | "setflag"
    | "addflag"
    | "removeflag";
  target?: string;
  message?: string;
  flags?: string[];
}

export interface SieveFilterSpec {
  name: string;
  description?: string;
  conditions: FilterCondition[];
  actions: FilterAction[];
  priority?: number;
  enabled?: boolean;
}

export interface EmailPattern {
  sender: string;
  domain: string;
  subject: string;
  frequency: number;
  category: string;
  confidence: number;
}

export interface FilterSuggestion {
  description: string;
  spec: SieveFilterSpec;
  patterns: EmailPattern[];
  estimatedMatches: number;
}

export class SieveError extends Error {
  constructor(
    message: string,
    public code?: string,
    public command?: string,
    public serverResponse?: string,
  ) {
    super(message);
    this.name = "SieveError";
  }
}
