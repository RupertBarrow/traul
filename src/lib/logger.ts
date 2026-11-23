let verbose = false;

let infoToStderr = false;

/** In every --json mode stdout is one JSON value: info lines go to stderr. */
export function setInfoToStderr(v: boolean): void {
  infoToStderr = v;
}

export function setVerbose(v: boolean): void {
  verbose = v;
}

export function debug(...args: unknown[]): void {
  if (verbose) {
    console.error("[DEBUG]", ...args);
  }
}

export function info(...args: unknown[]): void {
  (infoToStderr ? console.error : console.log)("[INFO]", ...args);
}

export function warn(...args: unknown[]): void {
  console.error("[WARN]", ...args);
}

export function error(...args: unknown[]): void {
  console.error("[ERROR]", ...args);
}
