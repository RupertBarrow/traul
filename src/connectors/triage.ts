import type { Connector } from "./types";
import { imapConnector } from "./imap";
import { markdownConnector } from "./markdown";
import { slackConnector } from "./slack";
import { whatsappConnector } from "./whatsapp";
import { facebookConnector } from "./facebook";

/** Connectors compiled into the Triage executable: `imap`, `slack`, `markdown`, `whatsapp` (WAHA) and `facebook` (Page inbox). */
export const triageConnectors: Connector[] = [imapConnector, slackConnector, markdownConnector, whatsappConnector, facebookConnector];
