import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { processStarted } from "./codex-session-record"

/**
 * Which of a `codex` process's plugin servers owns its Envoy session (INFRA-3558).
 *
 * Codex starts one MCP server per thread (measured on 0.154.0: `/new` starts a second server under
 * the same `codex` process while the first runs on until Codex unloads its thread, and `/side` and
 * `/btw` start one each for their fork). The record of the session the process runs is keyed by the
 * process, so every one of those servers would bind it and register the same session.
 *
 * So each server writes an entry of its own, `codex-servers/<codex pid>/<server pid>.json`, and the
 * owner is the oldest live entry. No file is taken over: every server reads the same entries and
 * reaches the same answer, and a server that is younger than a live one never owns. The others
 * stand by, serving their thread's `dispatch` calls, until every server older than them is gone.
 */
export interface CodexServerEntry {
  /** The server's pid. */
  readonly pid: number
  /** When the server registered, in milliseconds since the epoch: older owns. */
  readonly since: number
  /** When it started (`processStarted`), so a pid used again names nothing; null where it could
   *  not be read, and then only `ESRCH` says the server is gone. */
  readonly started: string | null
}

/** The directory of `codex` process `codexPid`'s servers, under the plugin's state directory. */
export function codexServersDirectory(stateDirectory: string, codexPid: number): string {
  return join(stateDirectory, "codex-servers", String(codexPid))
}

/** Writes `self`'s entry whole, through a temporary file renamed into place. */
export async function registerServer(directory: string, self: CodexServerEntry): Promise<void> {
  await mkdir(directory, { mode: 0o700, recursive: true })
  const temporary = join(directory, `.${self.pid}.${process.hrtime.bigint()}.tmp`)
  await writeFile(temporary, JSON.stringify(self), { mode: 0o600 })
  await rename(temporary, join(directory, `${self.pid}.json`))
}

/** Removes `self`'s entry. */
export async function unregisterServer(directory: string, self: CodexServerEntry): Promise<void> {
  await rm(join(directory, `${self.pid}.json`), { force: true })
}

/** How a liveness check reads a process: `kill(pid, 0)` and its start. */
export interface ProcessProbe {
  readonly signal: (pid: number) => void
  readonly started: (pid: number) => string | undefined
}

/** The start each live pid was last read at, so `ps` (off Linux) runs once per pid, not every
 *  poll. A pid's start changes only when the pid is used again, which `ESRCH` comes before. */
const startedOf = new Map<number, string | undefined>()

const SYSTEM_PROBE: ProcessProbe = {
  signal: (pid) => process.kill(pid, 0),
  started: (pid) => {
    if (!startedOf.has(pid)) startedOf.set(pid, processStarted(pid))
    return startedOf.get(pid)
  },
}

/**
 * Whether the server `entry` names still runs. It is gone only when its pid answers `ESRCH`, or
 * when both starts can be read and differ (the pid was used again); a start that cannot be read
 * now, as when `ps` fails, says nothing either way, so a live owner is never judged gone for it.
 */
export function serverAlive(entry: CodexServerEntry, probe: ProcessProbe = SYSTEM_PROBE): boolean {
  try {
    probe.signal(entry.pid)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      startedOf.delete(entry.pid)
      return false
    }
    // EPERM: a process runs under that pid.
  }
  const now = probe.started(entry.pid)
  return entry.started === null || now === undefined || now === entry.started
}

async function readEntries(directory: string): Promise<CodexServerEntry[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const entries: CodexServerEntry[] = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as CodexServerEntry
      if (typeof parsed.pid === "number" && typeof parsed.since === "number") entries.push(parsed)
    } catch {
      // Being written or removed: the next look reads it.
    }
  }
  return entries
}

/** The live server that owns the session: the oldest live entry, by `since`, then by pid. */
export async function currentOwner(
  directory: string,
  probe: ProcessProbe = SYSTEM_PROBE,
): Promise<CodexServerEntry | undefined> {
  const live = (await readEntries(directory)).filter((entry) => serverAlive(entry, probe))
  live.sort((a, b) => a.since - b.since || a.pid - b.pid)
  return live[0]
}

/** Resolves true once `self` owns the session, looking every `pollMs`, or false when `signal`
 *  aborts. */
export function waitForOwnership(
  directory: string,
  self: CodexServerEntry,
  signal: AbortSignal,
  pollMs = 1_000,
  probe: ProcessProbe = SYSTEM_PROBE,
): Promise<boolean> {
  return new Promise((done) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const look = (): void => {
      if (signal.aborted) return done(false)
      void currentOwner(directory, probe).then(
        (owner) => {
          if (owner?.pid === self.pid && owner.since === self.since) done(true)
          else timer = setTimeout(look, pollMs)
        },
        () => {
          timer = setTimeout(look, pollMs)
        },
      )
    }
    signal.addEventListener("abort", () => {
      if (timer !== undefined) clearTimeout(timer)
      done(false)
    })
    look()
  })
}
