import type { Connector } from "./types";
import { claudeCodeConnector } from "./claudecode";
import { discordConnector } from "./discord";
import { gmailConnector } from "./gmail";
import { linearConnector } from "./linear";
import { markdownConnector } from "./markdown";
import { slackConnector } from "./slack";
import { telegramConnector } from "./telegram";
import { whatsappConnector } from "./whatsapp";

/** Every built-in connector, in the order `traul sync` runs them. */
export const allConnectors: Connector[] = [
  claudeCodeConnector,
  discordConnector,
  gmailConnector,
  linearConnector,
  markdownConnector,
  slackConnector,
  telegramConnector,
  whatsappConnector,
];
