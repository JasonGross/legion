import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { queryTmux, sessionTitle, type TmuxQuery, tmuxPaneTitle } from "../src/session-title"

const SESSION_ID = "3084299d-32a7-41a3-ba9b-f61675b03b8d"
const SERVER_PID = "4242"
const TMUX = `/tmp/tmux-1000/default,${SERVER_PID},0`

/** A tmux server `pid` that answers every query with a pane in `session`, its window `window`
 *  with `automatic-rename` `automatic`, in group `group`, tab-joined as `display-message -p`
 *  prints them, and records the socket and pane each query named. */
function tmuxAnswering(
  session: string,
  window: string,
  automatic: string,
  { group = "", pid = SERVER_PID }: { group?: string; pid?: string } = {},
): TmuxQuery & { readonly asked: string[][] } {
  const asked: string[][] = []
  const query = (socket: string, pane: string) => {
    asked.push([socket, pane])
    return `${[session, window, automatic, group, pid].join("\t")}\n`
  }
  return Object.assign(query, { asked })
}

const noTmux: TmuxQuery = () => {
  throw new Error("tmux must not be asked")
}

const paneTitle = (query: TmuxQuery) => tmuxPaneTitle("s", SERVER_PID, "%3", query)

test("ENVOY_SESSION_TITLE names the session, ahead of tmux, on one line", () => {
  const title = sessionTitle(
    { ENVOY_SESSION_TITLE: "  review\n  the  listener ", TMUX, TMUX_PANE: "%3" },
    "/work/legion",
    noTmux,
  )
  expect(title(SESSION_ID)).toBe("review the listener")
  expect(title("ses_after_clear")).toBe("review the listener")
})

test("a blank or invisible ENVOY_SESSION_TITLE falls through to tmux, asked of the server TMUX names", () => {
  for (const blank of ["  ", "\u200b", " \u200b\u2060 "]) {
    const tmux = tmuxAnswering("work", "review", "0")
    const title = sessionTitle(
      { ENVOY_SESSION_TITLE: blank, TMUX, TMUX_PANE: "%3" },
      "/work/legion",
      tmux,
    )
    expect(title(SESSION_ID)).toBe("work:review 3084299d")
    expect(tmux.asked).toEqual([["/tmp/tmux-1000/default", "%3"]])
  }
})

test("the socket is TMUX up to its last two commas, so a path holding a comma still names it", () => {
  const tmux = tmuxAnswering("work", "review", "0")
  sessionTitle({ TMUX: `/tmp/a,b/default,${SERVER_PID},0`, TMUX_PANE: "%3" }, "/work/legion", tmux)
  expect(tmux.asked).toEqual([["/tmp/a,b/default", "%3"]])
})

test("a server started again on the same socket lends no name: its pane ids are another's", () => {
  // A `claude` that outlived its tmux server keeps the old TMUX, and the new server gives out %3
  // again, to someone else's pane.
  const restarted = tmuxAnswering("unrelated", "secret", "0", { pid: "9999" })
  expect(paneTitle(restarted)).toBeUndefined()
  expect(sessionTitle({ TMUX, TMUX_PANE: "%3" }, "/work/legion", restarted)(SESSION_ID)).toBe(
    "legion 3084299d",
  )
})

test("a window whose automatic-rename is off lends its name", () => {
  expect(paneTitle(tmuxAnswering("work", "review", "0"))).toBe("work:review")
  // A tmux that prints the flag as on/off rather than 1/0.
  expect(paneTitle(tmuxAnswering("work", "review", "off"))).toBe("work:review")
})

test("a pane of grouped sessions is named after the group, whichever session tmux answers with", () => {
  expect(paneTitle(tmuxAnswering("work-view", "review", "0", { group: "work" }))).toBe(
    "work:review",
  )
  expect(paneTitle(tmuxAnswering("work", "claude", "1"))).toBe("work")
})

test("a tmux too old to expand the format lends no name", () => {
  const unexpanded: TmuxQuery = () =>
    "#{session_name}\t#{window_name}\t#{automatic-rename}\t#{session_group}\t#{pid}\n"
  expect(tmuxPaneTitle("s", "#{pid}", "%3", unexpanded)).toBeUndefined()
})

test("an automatically named window reads as the session alone, never its index", () => {
  // automatic-rename names the window after the running command, which is the same in every pane,
  // and a window index moves under renumber-windows.
  expect(paneTitle(tmuxAnswering("work", "claude", "1"))).toBe("work")
  // A tmux too old to expand option names leaves the flag empty: the window's name is not trusted.
  expect(paneTitle(tmuxAnswering("work", "claude", ""))).toBe("work")
})

test("a session named only by digits lends no name in a window nobody named, so the project names it", () => {
  // Plain `tmux` names its first session `0`, which on every machine says nothing.
  expect(paneTitle(tmuxAnswering("0", "claude", "1"))).toBeUndefined()
  expect(
    sessionTitle(
      { TMUX, TMUX_PANE: "%3" },
      "/work/legion",
      tmuxAnswering("0", "claude", "1"),
    )(SESSION_ID),
  ).toBe("legion 3084299d")
  // A window someone named still names it.
  expect(paneTitle(tmuxAnswering("0", "review", "0"))).toBe("0:review")
})

test("sessions sharing a tmux window or session keep apart by their short ids", () => {
  const tmux = tmuxAnswering("split", "review", "0")
  const title = sessionTitle({ TMUX, TMUX_PANE: "%3" }, "/work/legion", tmux)
  expect(title("aaaaaaaa-1111")).toBe("split:review aaaaaaaa")
  expect(title("bbbbbbbb-2222")).toBe("split:review bbbbbbbb")
})

test("outside tmux, or when tmux cannot answer, the title is the project directory and the short id", () => {
  expect(sessionTitle({}, "/work/legion", noTmux)(SESSION_ID)).toBe("legion 3084299d")
  // A pane id names a pane only on its own server: without TMUX, tmux is not asked.
  expect(sessionTitle({ TMUX_PANE: "%3" }, "/work/legion", noTmux)(SESSION_ID)).toBe(
    "legion 3084299d",
  )
  expect(sessionTitle({ TMUX, TMUX_PANE: "%3" }, "/work/legion", () => undefined)(SESSION_ID)).toBe(
    "legion 3084299d",
  )
  expect(
    sessionTitle(
      { TMUX, TMUX_PANE: "%3" },
      "/work/legion",
      tmuxAnswering("", "zsh", "1"),
    )(SESSION_ID),
  ).toBe("legion 3084299d")
  expect(sessionTitle({ TMUX, TMUX_PANE: "%3" }, "/work/legion", () => "work\n")(SESSION_ID)).toBe(
    "legion 3084299d",
  )
})

test("the short id follows the id it is given, so a /clear handoff's new id shows", () => {
  const title = sessionTitle({}, "/work/legion/", noTmux)
  expect(title("aaaaaaaa-1111")).toBe("legion aaaaaaaa")
  expect(title("bbbbbbbb-2222")).toBe("legion bbbbbbbb")
  expect(sessionTitle({}, "/", noTmux)("cccccccc-3333")).toBe("/ cccccccc")
})

test("queryTmux answers undefined for a server that does not exist", () => {
  expect(queryTmux("/nonexistent/tmux.sock", "%0", "#{session_name}")).toBeUndefined()
})

// These two drive a real tmux server, and skip without one, as the tmux runtime's own tests do.
const hasTmux = Bun.which("tmux") !== null

test.skipIf(!hasTmux)(
  "a real tmux server answers a pane it does not have with no answer, and names its own pid",
  () => {
    // A running server answers a pane it does not have with an empty line and exit status 0.
    const directory = mkdtempSync(join(tmpdir(), "title-tmux-"))
    const socket = join(directory, "tmux.sock")
    execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "probe"])
    try {
      expect(queryTmux(socket, "%999999999", "#{session_name}")).toBeUndefined()
      const pid = execFileSync("tmux", ["-S", socket, "display-message", "-p", "#{pid}"], {
        encoding: "utf8",
      }).trim()
      const pane = execFileSync("tmux", ["-S", socket, "display-message", "-p", "#{pane_id}"], {
        encoding: "utf8",
      }).trim()
      expect(tmuxPaneTitle(socket, pid, pane)).toBe("probe")
      expect(tmuxPaneTitle(socket, "1", pane)).toBeUndefined()
    } finally {
      execFileSync("tmux", ["-S", socket, "kill-server"])
      rmSync(directory, { recursive: true, force: true })
    }
  },
)

test("queryTmux is bounded even by a tmux that ignores SIGTERM", () => {
  const directory = mkdtempSync(join(tmpdir(), "title-tmux-"))
  const marker = join(directory, "ran")
  writeFileSync(join(directory, "tmux"), `#!/bin/sh\ntrap "" TERM\ntouch ${marker}\nsleep 5\n`, {
    mode: 0o755,
  })
  // A child of its own, so the stub is first on the PATH it starts with: execFileSync looks
  // `tmux` up on the PATH the process was launched with.
  const source = join(import.meta.dir, "../src/session-title.ts")
  const started = Date.now()
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { queryTmux } from ${JSON.stringify(source)}; process.stdout.write(String(queryTmux("/nonexistent/tmux.sock", "%0", "x")))`,
      ],
      { env: { ...process.env, PATH: `${directory}:${process.env["PATH"] ?? ""}` } },
    )
    const elapsed = Date.now() - started
    expect(child.stdout.toString()).toBe("undefined")
    expect(existsSync(marker)).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(1_000)
    expect(elapsed).toBeLessThan(3_000)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
