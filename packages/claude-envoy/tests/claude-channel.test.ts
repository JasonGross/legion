import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type CommandLine,
  channelAllowlist,
  claudeChannelEntries,
  claudeChannelGate,
  installedMarketplace,
  processCommandLine,
} from "../src/claude-channel"

const plugin = { name: "claude-envoy", marketplace: "legion-plugins" }
const ORG_LIST = [{ marketplace: "legion-plugins", plugin: "claude-envoy" }]
const exact = (...argv: string[]): CommandLine => ({ argv: ["claude", ...argv], exact: true })

test("reads both channel flags, space-separated and inline, tagged entries only", () => {
  expect(
    claudeChannelEntries([
      "claude",
      "--channels",
      "plugin:claude-envoy@legion-plugins",
      "server:envoy",
      "untagged",
      "--model=opus",
      "--dangerously-load-development-channels=plugin:other@dev",
    ]),
  ).toEqual([
    { kind: "plugin", name: "claude-envoy", marketplace: "legion-plugins", dev: false },
    { kind: "server", name: "envoy", dev: false },
    { kind: "plugin", name: "other", marketplace: "dev", dev: true },
  ])
})

test("ignores a development channel in a print-mode session, but only on an exact command line", () => {
  const argv = [
    "claude",
    "-p",
    "--dangerously-load-development-channels",
    "plugin:claude-envoy@legion-plugins",
  ]
  expect(claudeChannelEntries(argv, true)).toEqual([])
  // `ps` output split on whitespace: a `-p` may be a word of a prompt, so the entry stays.
  expect(claudeChannelEntries(argv, false)).toHaveLength(1)
})

test("a session started without either flag has no channel", () => {
  const gate = claudeChannelGate({ commandLine: exact("--resume"), plugin, allowlist: ORG_LIST })
  expect(gate.loaded).toBe(false)
  expect(gate.loaded ? "" : gate.why).toBe(
    "claude was started without --channels plugin:claude-envoy@legion-plugins (or --dangerously-load-development-channels plugin:claude-envoy@legion-plugins)",
  )
})

test("a development channel naming this plugin is loaded", () => {
  expect(
    claudeChannelGate({
      commandLine: exact(
        "--dangerously-load-development-channels",
        "plugin:claude-envoy@legion-plugins",
      ),
      plugin,
      allowlist: undefined,
    }),
  ).toEqual({ loaded: true })
})

test("--channels loads this plugin only when an org allowlist names it", () => {
  const commandLine = exact("--channels", "plugin:claude-envoy@legion-plugins")
  expect(claudeChannelGate({ commandLine, plugin, allowlist: ORG_LIST })).toEqual({ loaded: true })
  expect(claudeChannelGate({ commandLine, plugin, allowlist: undefined })).toEqual({
    loaded: false,
    why: "plugin:claude-envoy@legion-plugins is not on Claude Code's approved channels allowlist (an organization adds it with allowedChannelPlugins in managed settings; for one session use --dangerously-load-development-channels plugin:claude-envoy@legion-plugins)",
  })
  expect(
    claudeChannelGate({
      commandLine,
      plugin,
      allowlist: [{ marketplace: "other", plugin: "x" }],
    }),
  ).toEqual({
    loaded: false,
    why: "plugin:claude-envoy@legion-plugins is not on your organization's approved channels list (allowedChannelPlugins in managed settings)",
  })
})

test("an entry from another marketplace than the installed plugin is skipped", () => {
  expect(
    claudeChannelGate({
      commandLine: exact("--dangerously-load-development-channels", "plugin:claude-envoy@dev"),
      plugin,
      allowlist: undefined,
    }),
  ).toEqual({
    loaded: false,
    why: "claude asked for plugin:claude-envoy@dev but this plugin is installed from legion-plugins",
  })
})

// A plugin's server is `plugin:claude-envoy:envoy` to Claude Code, which no `server:` entry names;
// a bare config's server is named by its config, which this process does not know.
test("a plugin takes only plugin entries, and a bare config any development server entry", () => {
  const serverEntry = exact("--dangerously-load-development-channels", "server:my-envoy")
  expect(claudeChannelGate({ commandLine: serverEntry, plugin, allowlist: undefined }).loaded).toBe(
    false,
  )
  expect(
    claudeChannelGate({ commandLine: serverEntry, plugin: undefined, allowlist: undefined }),
  ).toEqual({ loaded: true })
  expect(
    claudeChannelGate({
      commandLine: exact("--channels", "server:my-envoy"),
      plugin: undefined,
      allowlist: ORG_LIST,
    }).loaded,
  ).toBe(false)
})

test("a process it cannot read is taken as loaded, which is what it advertised before", () => {
  expect(claudeChannelGate({ commandLine: undefined, plugin, allowlist: undefined })).toEqual({
    loaded: true,
  })
})

test("names the marketplace of a cached plugin install, and none for any other path", () => {
  expect(
    installedMarketplace(
      "/home/u/.claude/plugins/cache/legion-plugins/claude-envoy/afe10b2f3e1b/dist/envoy-channel.js",
    ),
  ).toBe("legion-plugins")
  expect(installedMarketplace("/work/legion/packages/claude-envoy/dist/envoy-channel.js")).toBe(
    undefined,
  )
})

test("the highest managed settings source present is the allowlist alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-channel-"))
  try {
    const managed = join(root, "managed")
    const config = join(root, "config")
    const directories = { managedDirectory: managed, configDirectory: config }
    await mkdir(join(managed, "managed-settings.d"), { recursive: true })
    await mkdir(config, { recursive: true })
    expect(channelAllowlist(directories)).toBe(undefined)

    await writeFile(join(managed, "managed-settings.json"), JSON.stringify({ model: "x" }))
    await writeFile(
      join(managed, "managed-settings.d", "10-channels.json"),
      JSON.stringify({ allowedChannelPlugins: ORG_LIST }),
    )
    // An empty or unreadable cache of server-managed settings is no source.
    await writeFile(join(config, "remote-settings.json"), "{}")
    expect(channelAllowlist(directories)).toEqual(ORG_LIST)
    await writeFile(join(config, "remote-settings.json"), "not json")
    expect(channelAllowlist(directories)).toEqual(ORG_LIST)

    // Server-managed settings outrank the file, even when they set no allowlist.
    await writeFile(join(config, "remote-settings.json"), JSON.stringify({ model: "y" }))
    expect(channelAllowlist(directories)).toBe(undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reads a live process's command line", () => {
  const commandLine = processCommandLine(process.pid)
  expect(commandLine?.argv.some((argument) => argument.includes("bun"))).toBe(true)
})

// Claude Code sets process.title to "claude"; under Node that overwrites the arguments `ps` and
// /proc show, so a one-word command line from a Node process says nothing about the flags.
test("a one-word command line counts as unreadable only when Node runs it", async () => {
  const child = spawn("cat", [], { stdio: ["pipe", "ignore", "ignore"] })
  try {
    const pid = child.pid ?? 0
    await Bun.sleep(50)
    expect(processCommandLine(pid, () => "/usr/local/bin/node")).toBe(undefined)
    expect(processCommandLine(pid, () => "/bin/cat")?.argv).toHaveLength(1)
  } finally {
    child.kill()
  }
})
