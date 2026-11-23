import type { Command } from "commander";
import type { TraulConfig } from "./lib/config";
import { runWhatsAppAuth } from "./commands/whatsapp-auth";

export function registerWhatsAppCommands(program: Command, config: TraulConfig): void {
  const whatsapp = program
    .command("whatsapp")
    .description("WhatsApp connector commands");

  whatsapp
    .command("auth")
    .description("Authenticate a WhatsApp account via WAHA QR code")
    .argument("<account>", "account name matching config instance name")
    .action(async (account: string) => {
      await runWhatsAppAuth(config, account);
      process.exit(0);
    });
}
