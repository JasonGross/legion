import { expect, test } from "bun:test"
import { queryTmux, sessionTitle, type TmuxQuery, tmuxPaneTitle } from "../src/session-title"

const SESSION_ID = "3084299d-32a7-41a3-ba9b-f61675b03b8d"

/** A tmux that answers every query with `fields`, tab-joined as `display-message -p` prints them. */
function tmuxAnswering(...fields: string[]): TmuxQuery & { readonly panes: string[] } {
  const panes: string[] = []
  const query = (pane: string) => {
    panes.push(pane)
    return `${fields.join("\t")}\n`
  }
  return Object.assign(query, { panes })
}

const noTmux: TmuxQuery = () => {
  throw new Error("tmux must not be asked")
}

test("ENVOY_SESSION_TITLE names the session, ahead of tmux, on one line", () => {
  const title = sessionTitle(
    { ENVOY_SESSION_TITLE: "  review\n  the  listener ", TMUX_PANE: "%3" },
    "/work/legion",
    noTmux,
  )
  expect(title(SESSION_ID)).toBe("review the listener")
  expect(title("ses_after_clear")).toBe("review the listener")
})

test("a blank ENVOY_SESSION_TITLE falls through to tmux", () => {
  const tmux = tmuxAnswering("work", "3", "1", "review", "0")
  const title = sessionTitle({ ENVOY_SESSION_TITLE: "  ", TMUX_PANE: "%3" }, "/work/legion", tmux)
  expect(title(SESSION_ID)).toBe("work:review")
  expect(tmux.panes).toEqual(["%3"])
})

test("inside tmux a window someone named reads as session:window", () => {
  expect(tmuxPaneTitle("%3", tmuxAnswering("work", "3", "1", "review", "0"))).toBe("work:review")
  // A tmux that prints the flag as on/off rather than 1/0.
  expect(tmuxPaneTitle("%3", tmuxAnswering("work", "3", "1", "review", "off"))).toBe("work:review")
})

test("inside tmux an automatically named window reads as the session, with its index when the session has more", () => {
  // automatic-rename names the window after the running command, which is the same in every pane.
  expect(tmuxPaneTitle("%3", tmuxAnswering("work", "1", "0", "claude", "1"))).toBe("work")
  expect(tmuxPaneTitle("%3", tmuxAnswering("work", "4", "2", "claude", "1"))).toBe("work:2")
  // A tmux too old to expand option names leaves the flag empty: the window's name is not trusted.
  expect(tmuxPaneTitle("%3", tmuxAnswering("work", "4", "2", "claude", ""))).toBe("work:2")
})

test("outside tmux, or when tmux cannot answer, the title is the project directory and the short id", () => {
  expect(sessionTitle({}, "/work/legion", noTmux)(SESSION_ID)).toBe("legion 3084299d")
  expect(sessionTitle({ TMUX_PANE: "%3" }, "/work/legion", () => undefined)(SESSION_ID)).toBe(
    "legion 3084299d",
  )
  expect(
    sessionTitle(
      { TMUX_PANE: "%3" },
      "/work/legion",
      tmuxAnswering("", "1", "0", "zsh", "1"),
    )(SESSION_ID),
  ).toBe("legion 3084299d")
  expect(sessionTitle({ TMUX_PANE: "%3" }, "/work/legion", tmuxAnswering("work"))(SESSION_ID)).toBe(
    "legion 3084299d",
  )
})

test("the fallback follows the id it is given, so a /clear handoff's new id shows", () => {
  const title = sessionTitle({}, "/work/legion/", noTmux)
  expect(title("aaaaaaaa-1111")).toBe("legion aaaaaaaa")
  expect(title("bbbbbbbb-2222")).toBe("legion bbbbbbbb")
  expect(sessionTitle({}, "/", noTmux)("cccccccc-3333")).toBe("/ cccccccc")
})

test("queryTmux answers undefined for a pane no tmux server has", () => {
  expect(queryTmux("%999999999", "#{session_name}")).toBeUndefined()
})
