import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ONE owner of "who is this process's parent" for the Pi extensions.
//
// The extensions walk their own ancestry to answer whether this session owns
// the home's fleet lock. On macOS and Linux `ps -o ppid= -p <pid>` answers
// that directly and this file changes nothing.
//
// Git Bash is the exception. Its ps rejects -o outright ("ps: unknown option
// -- o"), so the POSIX read returns empty, the ancestry walk breaks on its
// first hop, and lockOwnership() can never reach the lock pid however close it
// is. It then falls through to "other": a session that genuinely OWNS the lock
// reports that something else does, and the extension declines to record that
// it even loaded. Nothing errors, which is what makes it expensive to notice.
//
// bin/fm-winproc-lib.sh already solved this for the shell side by bridging the
// MSYS and native Windows pid spaces, so this delegates to that owner rather
// than re-deriving the mapping in TypeScript. Node reports native Windows pids
// on win32, which is the space fm_winproc_ppid speaks.

const winprocLib = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../bin/fm-winproc-lib.sh",
);

function posixParentPid(pid: string): string {
  const result = spawnSync("ps", ["-o", "ppid=", "-p", pid], { encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function windowsParentPid(pid: string): string {
  const result = spawnSync(
    "bash",
    ["-c", '. "$0"; fm_winproc_ppid "$1"', winprocLib, pid],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

/** Parent pid of `pid`, or "" when it cannot be determined. */
export function firstmateParentPid(pid: string): string {
  if (!/^[0-9]+$/.test(pid)) return "";
  return process.platform === "win32" ? windowsParentPid(pid) : posixParentPid(pid);
}

// The same decision for the awaited caller, so the async supervision path is
// not made to block on a synchronous spawn just to answer this.
function parentPidCommand(pid: string): { command: string; args: string[] } {
  return process.platform === "win32"
    ? { command: "bash", args: ["-c", '. "$0"; fm_winproc_ppid "$1"', winprocLib, pid] }
    : { command: "ps", args: ["-o", "ppid=", "-p", pid] };
}

/** Awaited form of {@link firstmateParentPid}. */
export async function firstmateParentPidAsync(
  pid: string,
  run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ status: number | null; stdout: string }>,
): Promise<string> {
  if (!/^[0-9]+$/.test(pid)) return "";
  const { command, args } = parentPidCommand(pid);
  const result = await run(command, args);
  if (result.status !== 0) return "";
  return result.stdout.trim();
}
