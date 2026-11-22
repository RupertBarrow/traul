#!/usr/bin/env bun
import { bootstrap, newProgram, registerReadCommands, registerMaintenanceCommands, registerDaemonCommands } from "./cli";
import { registerWhatsAppCommands } from "./cli-whatsapp";
import { setConnectors } from "./connectors/registry";
import { allConnectors } from "./connectors/all";

setConnectors(allConnectors);
const { config, db } = bootstrap();
const program = newProgram();
registerReadCommands(program, db, config);
registerMaintenanceCommands(program, db);
registerWhatsAppCommands(program, config);
registerDaemonCommands(program, db, config);
program.parse();
