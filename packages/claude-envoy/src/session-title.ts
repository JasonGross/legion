import { execFileSync } from "node:child_process"
import { basename } from "node:path"
import { configuredValue } from "./claude-session"

export interface SessionTitleEnvironment {
  readonly ENVOY_SESSION_TITLE?: string | undefined
  readonly TMUX_PANE?: string | undefined
}

/**
 * The title registered for the session's current id. Every registration calls it, so the
 * fallback's short id follows a `/clear` handoff.
 */
export type SessionTitle = (sessionId: string) => string

/** What `tmux display-message -p` prints for `pane` and `format`; undefined when tmux cannot say. */
export type TmuxQuery = (pane: string, format: string) => string | undefined

// `automatic-rename` is the window option, which tmux expands as a format variable (1 or 0). A
// window someone named has it off; one left on it is named after the running command, `claude`
// in every pane, which tells sessions apart no better than nothing. `window_panes` and
// `pane_index` tell apart the Claude Code sessions in one split window.
const TMUX_PANE_FORMAT = [
  "#{session_name}",
  "#{session_windows}",
  "#{window_index}",
  "#{window_name}",
  "#{automatic-rename}",
  "#{window_panes}",
  "#{pane_index}",
].join("\t")

/** Bounds the one tmux call the server makes as it starts. */
const TMUX_TIMEOUT_MS = 1_000

const SHORT_ID_LENGTH = 8

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/**
 * `tmux display-message -p -t <pane> <format>`; undefined when tmux is missing, slow or refuses,
 * or prints nothing: a running tmux server answers a pane it does not have with an empty line and
 * exit status 0 (tmux 3.7b), not an error.
 */
export function queryTmux(pane: string, format: string): string | undefined {
  try {
    const answer = execFileSync("tmux", ["display-message", "-p", "-t", pane, format], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TMUX_TIMEOUT_MS,
    })
    return answer.trim() === "" ? undefined : answer
  } catch {
    return undefined
  }
}

/**
 * The tmux name of `pane`: `session:window` for a window someone named, else the session alone
 * when it has one window and `session:index` when it has more, then `.pane` when the window is
 * split. A session tmux numbered itself (plain `tmux` names its first one `0`) is named after
 * `project` instead: `legion 0`. Undefined when tmux cannot say.
 */
export function tmuxPaneTitle(
  pane: string,
  project: string,
  query: TmuxQuery = queryTmux,
): string | undefined {
  const fields = query(pane, TMUX_PANE_FORMAT)
    ?.replace(/\r?\n$/, "")
    .split("\t")
  if (fields === undefined || fields.length < 5) return undefined
  const [session = "", windows, index = "", window = "", automaticRename, panes, paneIndex = ""] =
    fields.map(oneLine)
  if (session === "") return undefined
  const named = /^[0-9]+$/.test(session) ? `${project} ${session}` : session
  const base =
    window !== "" && (automaticRename === "0" || automaticRename === "off")
      ? `${named}:${window}`
      : windows === "1" || index === ""
        ? named
        : `${named}:${index}`
  return panes !== undefined && panes !== "1" && paneIndex !== "" ? `${base}.${paneIndex}` : base
}

/**
 * The title this session registers with the Envoy listener, which Dispatch's Agents page shows in
 * place of the session id: `ENVOY_SESSION_TITLE`; else, inside tmux (`TMUX_PANE`), the pane's tmux
 * name; else the project directory's name and the id's first eight characters. Worked out once,
 * as the server starts: a tmux rename after that shows on the next start.
 */
export function sessionTitle(
  environment: SessionTitleEnvironment,
  directory: string,
  query: TmuxQuery = queryTmux,
): SessionTitle {
  const explicit = configuredValue(environment.ENVOY_SESSION_TITLE)
  if (explicit !== undefined) {
    const title = oneLine(explicit)
    return () => title
  }
  const project = basename(directory) || directory
  const pane = configuredValue(environment.TMUX_PANE)
  const tmux = pane === undefined ? undefined : tmuxPaneTitle(pane.trim(), project, query)
  if (tmux !== undefined) return () => tmux
  return (sessionId) => `${project} ${sessionId.slice(0, SHORT_ID_LENGTH)}`
}
