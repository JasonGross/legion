import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
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
 * So each server publishes an entry, `codex-servers/<codex pid>/<seq>-<server pid>.json`, taking
 * the next sequence number with an exclusive create, so two servers never hold one number and the
 * order is the order they published in, whatever the clock says. The owner is the live entry with
 * the lowest number. No file is taken over: every server reads the same entries and reaches the
 * same answer. The others stand by, serving their thread's `dispatch` calls, until every server
 * that published before them is gone.
 */
export interface CodexServerEntry {
  /** The publication number: lower owns. */
  readonly seq: number
  /** The server's pid. */
  readonly pid: number
  /** When it started (`processStarted`), so a pid used again names nothing; null where it could
   *  not be read, and then only `ESRCH` says the server is gone. */
  readonly started: string | null
}

/** The directory of `codex` process `codexPid`'s servers, under the plugin's state directory. */
export function codexServersDirectory(stateDirectory: string, codexPid: number): string {
  return join(stateDirectory, "codex-servers", String(codexPid))
}

const ENTRY_NAME = /^(\d+)-(\d+)\.json$/

function entryName(entry: { readonly seq: number; readonly pid: number }): string {
  return `${entry.seq}-${entry.pid}.json`
}

/**
 * Publishes an entry for server `pid`, at the lowest sequence number above every entry there, and
 * answers it. The create is exclusive (`wx`), so a server that loses a number to another takes the
 * next one.
 */
export async function registerServer(
  directory: string,
  pid: number,
  started: string | null,
): Promise<CodexServerEntry> {
  await mkdir(directory, { mode: 0o700, recursive: true })
  let seq = Math.max(0, ...(await entryNames(directory)).map(({ seq: taken }) => taken)) + 1
  for (;;) {
    try {
      await writeFile(join(directory, entryName({ pid, seq })), JSON.stringify({ started }), {
        flag: "wx",
        mode: 0o600,
      })
      return { pid, seq, started }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      seq++
    }
  }
}

/** Removes `self`'s entry. */
export async function unregisterServer(directory: string, self: CodexServerEntry): Promise<void> {
  await rm(join(directory, entryName(self)), { force: true })
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

/** Whether a liveness check found the pid gone (`ESRCH`), and not merely unreadable. */
function gone(pid: number, probe: ProcessProbe): boolean {
  try {
    probe.signal(pid)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false // EPERM: a process runs.
    startedOf.delete(pid)
    return true
  }
}

/**
 * Whether the server `entry` names still runs. It is gone only when its pid answers `ESRCH`, or
 * when both starts can be read and differ (the pid was used again); a start that cannot be read
 * now, as when `ps` fails, says nothing either way, so a live owner is never judged gone for it.
 */
export function serverAlive(entry: CodexServerEntry, probe: ProcessProbe = SYSTEM_PROBE): boolean {
  if (gone(entry.pid, probe)) return false
  const now = probe.started(entry.pid)
  return entry.started === null || now === undefined || now === entry.started
}

async function entryNames(
  directory: string,
): Promise<{ seq: number; pid: number; name: string }[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const match = ENTRY_NAME.exec(name)
    return match === null ? [] : [{ name, pid: Number(match[2]), seq: Number(match[1]) }]
  })
}

async function readEntries(directory: string): Promise<CodexServerEntry[]> {
  const entries: CodexServerEntry[] = []
  for (const { name, pid, seq } of await entryNames(directory)) {
    let started: string | null = null
    try {
      const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as {
        started?: unknown
      }
      if (typeof parsed.started === "string") started = parsed.started
    } catch {
      // Being written, or removed: the name holds the order and the pid, and the start is unknown.
    }
    entries.push({ pid, seq, started })
  }
  return entries
}

/**
 * The live server that owns the session: the live entry with the lowest number. An entry whose
 * pid answers `ESRCH` is removed on the way: its name is never published again, since numbers only
 * grow, so removing it cannot remove a live server's entry.
 */
export async function currentOwner(
  directory: string,
  probe: ProcessProbe = SYSTEM_PROBE,
): Promise<CodexServerEntry | undefined> {
  const live: CodexServerEntry[] = []
  for (const entry of await readEntries(directory)) {
    if (gone(entry.pid, probe)) {
      await rm(join(directory, entryName(entry)), { force: true }).catch(() => undefined)
      continue
    }
    if (serverAlive(entry, probe)) live.push(entry)
  }
  live.sort((a, b) => a.seq - b.seq || a.pid - b.pid)
  return live[0]
}

/**
 * Resolves with `self`'s entry once it owns the session, looking every `pollMs`, or undefined when
 * `signal` aborts. It publishes the entry first, and again at any look that finds it gone (a
 * failed write, or a directory someone removed), which puts the server at the back of the order.
 */
export function waitForOwnership(
  directory: string,
  pid: number,
  started: string | null,
  signal: AbortSignal,
  pollMs = 1_000,
  probe: ProcessProbe = SYSTEM_PROBE,
): Promise<CodexServerEntry | undefined> {
  return new Promise((done) => {
    let self: CodexServerEntry | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const look = async (): Promise<void> => {
      if (signal.aborted) return done(undefined)
      const names = await entryNames(directory)
      if (
        self === undefined ||
        !names.some((entry) => entry.seq === self?.seq && entry.pid === pid)
      ) {
        self = await registerServer(directory, pid, started)
      }
      const owner = await currentOwner(directory, probe)
      if (owner?.seq === self.seq && owner.pid === pid) done(self)
      else timer = setTimeout(() => void look().catch(retry), pollMs)
    }
    const retry = (): void => {
      timer = setTimeout(() => void look().catch(retry), pollMs)
    }
    signal.addEventListener("abort", () => {
      if (timer !== undefined) clearTimeout(timer)
      done(undefined)
    })
    void look().catch(retry)
  })
}

/** Whether `self` still owns the session: the owner re-checks at each look, so a split that
 *  started anyway (an entry another server could not see when it decided) ends. */
export async function stillOwner(
  directory: string,
  self: CodexServerEntry,
  probe: ProcessProbe = SYSTEM_PROBE,
): Promise<boolean> {
  const owner = await currentOwner(directory, probe)
  return owner === undefined || (owner.seq === self.seq && owner.pid === self.pid)
}
