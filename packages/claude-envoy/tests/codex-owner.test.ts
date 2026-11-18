import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { temporaryDirectory } from "@legion/test-fixtures/temporary-directories"
import {
  claimOwner,
  codexOwnerFile,
  ownerAlive,
  releaseOwner,
  waitForOwner,
} from "../src/codex/codex-owner"

describe("the owner of a codex process's Envoy session", () => {
  const root = temporaryDirectory("codex-owner")
  // Two servers, both alive, and one that is gone.
  const starts = new Map([
    [101, "s101"],
    [102, "s102"],
  ])
  const started = (pid: number): string | undefined => starts.get(pid)
  const first = { pid: 101, started: "s101" }
  const second = { pid: 102, started: "s102" }

  test("is the first server; a second stands by while the first lives", async () => {
    const file = codexOwnerFile(join(root, "a"), 7)
    expect(await claimOwner(file, first, started)).toBe(true)
    expect(await claimOwner(file, second, started)).toBe(false)
    // Claiming again is idempotent for the holder.
    expect(await claimOwner(file, first, started)).toBe(true)
  })

  test("passes to a standing-by server once the holder is gone or has released it", async () => {
    const file = codexOwnerFile(join(root, "b"), 7)
    expect(await claimOwner(file, { pid: 999, started: "gone" }, started)).toBe(true)
    expect(await claimOwner(file, second, started)).toBe(true)
    await releaseOwner(file, first)
    expect(await claimOwner(file, first, started)).toBe(false)
    await releaseOwner(file, second)
    expect(await claimOwner(file, first, started)).toBe(true)
  })

  test("a reused pid with another start is not alive", () => {
    expect(ownerAlive({ pid: 101, started: "s101" }, started)).toBe(true)
    expect(ownerAlive({ pid: 101, started: "earlier" }, started)).toBe(false)
    expect(ownerAlive({ pid: 555, started: "x" }, started)).toBe(false)
  })

  test("waiting for it resolves false when the server stops first", async () => {
    const file = codexOwnerFile(join(root, "c"), 7)
    // This very process, alive, holds it.
    const holder = { pid: process.pid, started: "held" }
    await claimOwner(file, holder, () => "held")
    const abort = new AbortController()
    const waited = waitForOwner(file, { pid: process.pid, started: "other" }, abort.signal, 10)
    abort.abort()
    expect(await waited).toBe(false)
  })
})
