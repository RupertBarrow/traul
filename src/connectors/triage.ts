import type { Connector } from "./types";
import { imapConnector } from "./imap";

/** Connectors compiled into the Triage executable: `imap` only. */
export const triageConnectors: Connector[] = [imapConnector];
