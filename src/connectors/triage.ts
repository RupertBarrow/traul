import type { Connector } from "./types";
import { imapConnector } from "./imap";
import { markdownConnector } from "./markdown";
import { slackConnector } from "./slack";

/** Connectors compiled into the Triage executable: `imap`, `slack` and `markdown`. */
export const triageConnectors: Connector[] = [imapConnector, slackConnector, markdownConnector];
