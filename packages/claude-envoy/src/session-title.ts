import { execFileSync } from "node:child_process"
import { basename } from "node:path"
import { configuredValue } from "./claude-session"

export interface SessionTitleEnvironment {
  readonly ENVOY_SESSION_TITLE?: string | undefined
  readonly TMUX?: string | undefined
  readonly TMUX_PANE?: string | undefined
}

/**
 * The title registered for the session's current id. Every registration calls it, so the short
 * id in it follows a `/clear` handoff.
 */
export type SessionTitle = (sessionId: string) => string

/** What `tmux -S <socket> display-message -p` prints for `pane` and `format`; undefined when tmux
 *  cannot say. */
export type TmuxQuery = (socket: string, pane: string, format: string) => string | undefined

// `automatic-rename` is the window option, which tmux expands as a format variable (1 or 0). A
// window left on it is named after the running command, `claude` in every pane, which tells
// sessions apart no better than nothing, so only a window with it off lends its name. A window
// index is never used: with `renumber-windows` on, tmux moves it after the title is worked out.
// A pane of grouped sessions answers with whichever session of the group tmux picks, so the
// group's name stands in for it, which tmux keeps even after the sessions are renamed or end.
// `pid` is the server's: a pane id names a pane only on the server that gave it out, and a server
// started again on the same socket gives out the same ids.
const TMUX_PANE_FORMAT = [
  "#{session_name}",
  "#{window_name}",
  "#{automatic-rename}",
  "#{session_group}",
  "#{pid}",
].join("\t")

/** Bounds the one tmux call the server makes as it starts. */
const TMUX_TIMEOUT_MS = 1_000

const SHORT_ID_LENGTH = 8

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/**
 * `tmux -S <socket> display-message -p -t <pane> <format>`; undefined when tmux is missing, slow
 * or refuses, or prints nothing: a running tmux server answers a pane it does not have with an
 * empty line and exit status 0 (tmux 3.7b), not an error.
 */
export function queryTmux(socket: string, pane: string, format: string): string | undefined {
  try {
    const answer = execFileSync(
      "tmux",
      ["-S", socket, "display-message", "-p", "-t", pane, format],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: TMUX_TIMEOUT_MS,
        // A `tmux` that ignores SIGTERM (a wrapper script) would hold the server's start past the
        // bound; SIGKILL cannot be ignored.
        killSignal: "SIGKILL",
      },
    )
    return answer.trim() === "" ? undefined : answer
  } catch {
    return undefined
  }
}

/**
 * The tmux name of `pane` on the server at `socket` whose process is `serverPid`: `session:window`
 * for a window whose `automatic-rename` is off, else the tmux session's name. Undefined when tmux
 * cannot say, when another server now answers on that socket, and for a session named only by
 * digits (plain `tmux` names its first one `0`) in a window nobody named, since that says nothing
 * on any machine.
 */
export function tmuxPaneTitle(
  socket: string,
  serverPid: string,
  pane: string,
  query: TmuxQuery = queryTmux,
): string | undefined {
  const fields = query(socket, pane, TMUX_PANE_FORMAT)
    ?.replace(/\r?\n$/, "")
    .split("\t")
  if (fields === undefined || fields.length < 5) return undefined
  const [name = "", window = "", automaticRename, group = "", pid] = fields.map(oneLine)
  if (pid !== serverPid) return undefined
  const session = group === "" ? name : group
  // A tmux too old to expand a format prints it as it was sent.
  if (session === "" || session.startsWith("#{")) return undefined
  if (window !== "" && (automaticRename === "0" || automaticRename === "off")) {
    return `${session}:${window}`
  }
  return /^[0-9]+$/.test(session) ? undefined : session
}

/**
 * The title this session registers with the Envoy listener, which Dispatch's Agents page shows in
 * place of the session id: `ENVOY_SESSION_TITLE`; else a name and the current id's first eight
 * characters, the name being the pane's tmux name inside tmux (`TMUX` and `TMUX_PANE`, asked of
 * the server `TMUX` names) and the project directory's name otherwise. The short id keeps two
 * sessions that share a tmux window or session apart. The name is worked out once, as the server
 * starts: a tmux rename after that shows on the next start.
 */
export function sessionTitle(
  environment: SessionTitleEnvironment,
  directory: string,
  query: TmuxQuery = queryTmux,
): SessionTitle {
  const explicit = configuredValue(environment.ENVOY_SESSION_TITLE)
  // A title of only invisible characters (a zero-width space) would show as a blank row.
  if (explicit !== undefined && explicit.replace(/[\s\p{Cf}]/gu, "") !== "") {
    const title = oneLine(explicit)
    return () => title
  }
  // `TMUX` is `<socket>,<server pid>,<session>`, and a socket path may hold a comma.
  const parts = configuredValue(environment.TMUX)?.split(",") ?? []
  const socket = parts.slice(0, -2).join(",")
  const serverPid = parts.at(-2) ?? ""
  const pane = configuredValue(environment.TMUX_PANE)?.trim()
  const name =
    (socket === "" || serverPid === "" || pane === undefined
      ? undefined
      : tmuxPaneTitle(socket, serverPid, pane, query)) ??
    (basename(directory) || directory)
  return (sessionId) => `${name} ${sessionId.slice(0, SHORT_ID_LENGTH)}`
}
