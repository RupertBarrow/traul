import type { Connector } from "./types";
import type { TraulConfig } from "../lib/config";

let _connectors: Connector[] = [];

/** Register the connectors this executable runs (see src/index.ts, src/index.triage.ts). */
export function setConnectors(list: Connector[]): void {
  _connectors = [...list];
}

export function getConnectors(): Connector[] {
  return _connectors;
}

/** Get a single connector by name */
export function getConnector(name: string): Connector | undefined {
  return getConnectors().find((c) => c.name === name);
}

/** Get all connector names */
export function getConnectorNames(): string[] {
  return getConnectors().map((c) => c.name);
}

/** Check which connectors have valid credentials */
export function getCredsStatus(config: TraulConfig): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const c of getConnectors()) {
    result[c.name] = c.hasCredentials ? c.hasCredentials(config) : true;
  }
  return result;
}

/** Get default interval for a connector (falls back to 300s) */
export function getDefaultInterval(name: string): number {
  const c = getConnector(name);
  return c?.defaultInterval ?? 300;
}
