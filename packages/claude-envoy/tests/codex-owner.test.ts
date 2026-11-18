import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { temporaryDirectory } from "@legion/test-fixtures/temporary-directories"
import {
  type CodexServerEntry,
  currentOwner,
  type ProcessProbe,
  registerServer,
  serverAlive,
  unregisterServer,
  waitForOwnership,
} from "../src/codex/codex-owner"

const ownerModule = resolve(import.meta.dir, "../src/codex/codex-owner.ts")

/** A probe over a fixed table: pids not in it answer ESRCH. */
function probeOf(table: Record<number, string | undefined>): ProcessProbe {
  return {
    signal: (pid) => {
      if (!(pid in table)) throw Object.assign(new Error("no such process"), { code: "ESRCH" })
    },
    started: (pid) => table[pid],
  }
}

describe("the owner of a codex process's Envoy session", () => {
  const root = temporaryDirectory("codex-owner")
  const older: CodexServerEntry = { pid: 101, since: 1_000, started: "s101" }
  const younger: CodexServerEntry = { pid: 102, since: 2_000, started: "s102" }

  test("is the oldest live server, and passes to the next oldest when it is gone", async () => {
    const directory = join(root, "a")
    await registerServer(directory, younger)
    await registerServer(directory, older)
    expect((await currentOwner(directory, probeOf({ 101: "s101", 102: "s102" })))?.pid).toBe(101)
    expect((await currentOwner(directory, probeOf({ 102: "s102" })))?.pid).toBe(102)
    await unregisterServer(directory, older)
    expect((await currentOwner(directory, probeOf({ 101: "s101", 102: "s102" })))?.pid).toBe(102)
  })

  test("is gone only on ESRCH or a readable start that differs", () => {
    expect(serverAlive(older, probeOf({ 101: "s101" }))).toBe(true)
    // A start that cannot be read now says nothing either way.
    expect(serverAlive(older, probeOf({ 101: undefined }))).toBe(true)
    expect(serverAlive({ ...older, started: null }, probeOf({ 101: "other" }))).toBe(true)
    expect(serverAlive(older, probeOf({ 101: "reused" }))).toBe(false)
    expect(serverAlive(older, probeOf({}))).toBe(false)
  })

  test("a file being written is never read as an entry", async () => {
    const directory = join(root, "b")
    await registerServer(directory, younger)
    writeFileSync(join(directory, "103.json"), "")
    expect((await currentOwner(directory, probeOf({ 102: "s102", 103: "s103" })))?.pid).toBe(102)
  })

  test("waiting for it resolves false when the server stops first", async () => {
    const directory = join(root, "c")
    await registerServer(directory, older)
    const abort = new AbortController()
    const waited = waitForOwnership(
      directory,
      younger,
      abort.signal,
      10,
      probeOf({ 101: "s101", 102: "s102" }),
    )
    abort.abort()
    expect(await waited).toBe(false)
  })

  test("two server processes racing for a dead owner's place: exactly one owns", async () => {
    for (let run = 0; run < 10; run++) {
      const directory = join(root, `race-${run}`)
      // A dead owner, older than both racers.
      await registerServer(directory, { pid: 2 ** 22 + 17, since: 1, started: "dead" })
      const racer = (since: number) =>
        Bun.spawn(
          [
            process.execPath,
            "-e",
            `const m = await import(${JSON.stringify(ownerModule)});
             const self = { pid: process.pid, since: ${since}, started: null };
             await m.registerServer(${JSON.stringify(directory)}, self);
             await Bun.sleep(50);
             const owner = await m.currentOwner(${JSON.stringify(directory)});
             process.stdout.write(owner?.pid === process.pid ? "owner" : "standby");
             await Bun.sleep(300);`,
          ],
          { stdout: "pipe" },
        )
      const a = racer(10)
      const b = racer(20)
      const said = [await new Response(a.stdout).text(), await new Response(b.stdout).text()]
      await Promise.all([a.exited, b.exited])
      expect(said.sort()).toEqual(["owner", "standby"])
    }
  }, 60_000)
})
