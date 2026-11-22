// Entry point of the executable compiled into the Triage app: the Triage
// connectors only (docs/triage-fork/SPEC.md, section 3).
import { bootstrap, runDatabaseFree, newProgram, registerReadCommands, registerMaintenanceCommands, registerDaemonCommands } from "./cli";
import { registerImapCommands } from "./commands/imap";
import { registerImportCommand } from "./commands/import";
import { setConnectors } from "./connectors/registry";
import { triageConnectors } from "./connectors/triage";

setConnectors(triageConnectors);
if (await runDatabaseFree(process.argv)) process.exit(process.exitCode ?? 0);
const { config, db } = bootstrap();
const program = newProgram();
registerReadCommands(program, db, config);
registerMaintenanceCommands(program, db);
registerDaemonCommands(program, db, config);
registerImapCommands(program, config);
registerImportCommand(program, db);
program.parse();
