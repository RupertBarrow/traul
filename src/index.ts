#!/usr/bin/env bun
import { bootstrap, runDatabaseFree, newProgram, registerReadCommands, registerMaintenanceCommands, registerDaemonCommands } from "./cli";
import { registerWhatsAppCommands } from "./cli-whatsapp";
import { registerImapCommands } from "./commands/imap";
import { setConnectors } from "./connectors/registry";
import { allConnectors } from "./connectors/all";

setConnectors(allConnectors);
if (await runDatabaseFree(process.argv)) process.exit(process.exitCode ?? 0);
const { config, db } = bootstrap();
const program = newProgram();
registerReadCommands(program, db, config);
registerMaintenanceCommands(program, db);
registerWhatsAppCommands(program, config);
registerDaemonCommands(program, db, config);
registerImapCommands(program, config);
program.parse();
