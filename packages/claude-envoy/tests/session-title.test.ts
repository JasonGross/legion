import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { queryTmux, sessionTitle, type TmuxQuery, tmuxPaneTitle } from "../src/session-title"

const SESSION_ID = "3084299d-32a7-41a3-ba9b-f61675b03b8d"
const TMUX = "/tmp/tmux-1000/default,4242,0"

/** A tmux that answers every query with `fields`, tab-joined as `display-message -p` prints them,
 *  and records the socket and pane each query named. */
function tmuxAnswering(...fields: string[]): TmuxQuery & { readonly asked: string[][] } {
  const asked: string[][] = []
  const query = (socket: string, pane: string) => {
    asked.push([socket, pane])
    return `${fields.join("\t")}\n`
  }
  return Object.assign(query, { asked })
}

const noTmux: TmuxQuery = () => {
  throw new Error("tmux must not be asked")
}

test("ENVOY_SESSION_TITLE names the session, ahead of tmux, on one line", () => {
  const title = sessionTitle(
    { ENVOY_SESSION_TITLE: "  review\n  the  listener ", TMUX, TMUX_PANE: "%3" },
    "/work/legion",
    noTmux,
  )
  expect(title(SESSION_ID)).toBe("review the listener")
  expect(title("ses_after_clear")).toBe("review the listener")
})

test("a blank ENVOY_SESSION_TITLE falls through to tmux, asked of the server TMUX names", () => {
  const tmux = tmuxAnswering("work", "review", "0")
  const title = sessionTitle(
    { ENVOY_SESSION_TITLE: "  ", TMUX, TMUX_PANE: "%3" },
    "/work/legion",
    tmux,
  )
  expect(title(SESSION_ID)).toBe("work:review 3084299d")
  expect(tmux.asked).toEqual([["/tmp/tmux-1000/default", "%3"]])
})

test("the socket is TMUX up to its last two commas, so a path holding a comma still names it", () => {
  const tmux = tmuxAnswering("work", "review", "0")
  sessionTitle({ TMUX: "/tmp/a,b/default,4242,0", TMUX_PANE: "%3" }, "/work/legion", tmux)
  expect(tmux.asked).toEqual([["/tmp/a,b/default", "%3"]])
})

test("a window whose automatic-rename is off lends its name", () => {
  expect(tmuxPaneTitle("s", "%3", tmuxAnswering("work", "review", "0"))).toBe("work:review")
  // A tmux that prints the flag as on/off rather than 1/0.
  expect(tmuxPaneTitle("s", "%3", tmuxAnswering("work", "review", "off"))).toBe("work:review")
})

test("a pane of grouped sessions is named after the group, whichever session tmux answers with", () => {
  expect(tmuxPaneTitle("s", "%3", tmuxAnswering("work-view", "review", "0", "work"))).toBe(
    "work:review",
  )
  expect(tmuxPaneTitle("s", "%3", tmuxAnswering("work", "claude", "1", ""))).toBe("work")
})

test("a tmux too old to expand the format lends no name", () => {
  expect(
    tmuxPaneTitle(
      "s",
      "%3",
      tmuxAnswering("#{session_name}", "#{window_name}", "#{automatic-rename}"),
    ),
  ).toBeUndefined()
})

test("an automatically named window reads as the session alone, never its index", () => {
  // automatic-rename names the window after the running command, which is the same in every pane,
  // and a window index moves under renumber-windows.
  expect(tmuxPaneTitle("s", "%3", tmuxAnswering("work", "claude", "1"))).toBe("work")
  // A tmux too old to expand option names leaves the flag empty: the window's name is not trusted.
  expect(tmuxPaneTitle("s", "%3", tmuxAnswering("work", "claude", ""))).toBe("work")
})

test("a session tmux numbered itself lends no name, so the project names it", () => {
  // Plain `tmux` names its first session `0`, which on every machine says nothing.
  expect(tmuxPaneTitle("s", "%3", tmuxAnswering("0", "claude", "1"))).toBeUndefined()
  expect(
    sessionTitle(
      { TMUX, TMUX_PANE: "%3" },
      "/work/legion",
      tmuxAnswering("0", "claude", "1"),
    )(SESSION_ID),
  ).toBe("legion 3084299d")
  // A window someone named still names it.
  expect(tmuxPaneTitle("s", "%3", tmuxAnswering("0", "review", "0"))).toBe("0:review")
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
  expect(
    sessionTitle({ TMUX, TMUX_PANE: "%3" }, "/work/legion", tmuxAnswering("work"))(SESSION_ID),
  ).toBe("legion 3084299d")
})

test("the short id follows the id it is given, so a /clear handoff's new id shows", () => {
  const title = sessionTitle({}, "/work/legion/", noTmux)
  expect(title("aaaaaaaa-1111")).toBe("legion aaaaaaaa")
  expect(title("bbbbbbbb-2222")).toBe("legion bbbbbbbb")
  expect(sessionTitle({}, "/", noTmux)("cccccccc-3333")).toBe("/ cccccccc")
})

test("queryTmux answers undefined for a server that does not exist and for a pane it does not have", () => {
  expect(queryTmux("/nonexistent/tmux.sock", "%0", "#{session_name}")).toBeUndefined()
  // A running server answers a pane it does not have with an empty line and exit status 0.
  const directory = mkdtempSync(join(tmpdir(), "title-tmux-"))
  const socket = join(directory, "tmux.sock")
  execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "probe"])
  try {
    expect(queryTmux(socket, "%999999999", "#{session_name}")).toBeUndefined()
    expect(queryTmux(socket, "probe:", "#{session_name}")).toBe("probe\n")
  } finally {
    execFileSync("tmux", ["-S", socket, "kill-server"])
    rmSync(directory, { recursive: true, force: true })
  }
})

test("queryTmux is bounded even by a tmux that ignores SIGTERM", () => {
  const directory = mkdtempSync(join(tmpdir(), "title-tmux-"))
  const stubborn = join(directory, "tmux")
  writeFileSync(stubborn, '#!/bin/sh\ntrap "" TERM\nsleep 5\n', { mode: 0o755 })
  const path = process.env["PATH"]
  process.env["PATH"] = `${directory}:${path ?? ""}`
  const started = Date.now()
  try {
    expect(queryTmux("/nonexistent/tmux.sock", "%0", "#{session_name}")).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(3_000)
  } finally {
    process.env["PATH"] = path
    rmSync(directory, { recursive: true, force: true })
  }
})
