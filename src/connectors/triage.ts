import type { Connector } from "./types";
import { archiveConnector } from "./archive-connector";
import { imapConnector } from "./imap";

/** Connectors compiled into the Triage executable: `imap` and `archive`. */
export const triageConnectors: Connector[] = [imapConnector, archiveConnector];
