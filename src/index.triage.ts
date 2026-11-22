// Entry point of the executable compiled into the Triage app: the Triage
// connectors only (docs/triage-fork/SPEC.md, section 3).
import { bootstrap, newProgram, registerReadCommands, registerMaintenanceCommands, registerDaemonCommands } from "./cli";
import { setConnectors } from "./connectors/registry";
import { triageConnectors } from "./connectors/triage";

setConnectors(triageConnectors);
const { config, db } = bootstrap();
const program = newProgram();
registerReadCommands(program, db, config);
registerMaintenanceCommands(program, db);
registerDaemonCommands(program, db, config);
program.parse();
