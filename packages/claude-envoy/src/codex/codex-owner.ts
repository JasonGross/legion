import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { processStarted } from "./codex-session-record"

/**
 * Which of a `codex` process's plugin servers owns its Envoy session (INFRA-3558).
 *
 * Codex starts one MCP server per thread (measured on 0.154.0: `/new` starts a second server under
 * the same `codex` process while the first runs on until Codex unloads its thread, and `/side` and
 * `/btw` start one each for their fork). The record of the session the process runs is keyed by the
 * process, so every one of those servers would bind it and register the same session. The first
 * server takes this file and serves the session; any other stands by, serving its thread's
 * `dispatch` calls only, and takes the file over once the server that holds it is gone.
 */
export interface CodexOwner {
  /** The owning server's pid. */
  readonly pid: number
  /** When it started (`processStarted`), so a pid used again names nothing. */
  readonly started: string
}

/** The owner file of `codex` process `codexPid`, under the plugin's state directory. */
export function codexOwnerFile(stateDirectory: string, codexPid: number): string {
  return join(stateDirectory, "codex-owners", `${codexPid}.json`)
}

/** Whether `owner` is a server that still runs: its pid is alive and started when it says. */
export function ownerAlive(
  owner: CodexOwner,
  started: (pid: number) => string | undefined = processStarted,
): boolean {
  const now = started(owner.pid)
  return now !== undefined && now === owner.started
}

async function readOwner(file: string): Promise<CodexOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as CodexOwner).pid === "number" &&
      typeof (parsed as CodexOwner).started === "string"
    ) {
      return parsed as CodexOwner
    }
  } catch {
    // Missing or unreadable: no owner.
  }
  return undefined
}

/**
 * Takes `file` for `self` when no live server holds it, and answers whether `self` holds it now.
 * The write is exclusive (`wx`), so two servers that both find it free do not both win: the loser
 * reads the winner's file and stands by.
 */
export async function claimOwner(
  file: string,
  self: CodexOwner,
  started: (pid: number) => string | undefined = processStarted,
): Promise<boolean> {
  await mkdir(dirname(file), { mode: 0o700, recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, JSON.stringify(self), { flag: "wx", mode: 0o600 })
      return true
    } catch {
      const holder = await readOwner(file)
      if (holder !== undefined && holder.pid === self.pid && holder.started === self.started) {
        return true
      }
      if (holder !== undefined && ownerAlive(holder, started)) return false
      // A server that is gone, or a file nothing can read: removed, then tried once more.
      await rm(file, { force: true })
    }
  }
  return false
}

/** Gives `file` up, when `self` holds it. */
export async function releaseOwner(file: string, self: CodexOwner): Promise<void> {
  const holder = await readOwner(file)
  if (holder?.pid === self.pid && holder.started === self.started) await rm(file, { force: true })
}

/** Resolves true once `self` holds `file`, looking every `pollMs`, or false when `signal` aborts. */
export function waitForOwner(
  file: string,
  self: CodexOwner,
  signal: AbortSignal,
  pollMs = 1_000,
): Promise<boolean> {
  return new Promise((done) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const look = (): void => {
      if (signal.aborted) return done(false)
      void claimOwner(file, self).then(
        (held) => {
          if (held) done(true)
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
