import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, readlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, sep } from "node:path"
import { z } from "zod"

/**
 * Whether Claude Code passes this server's channel notifications to the model. It says nothing
 * about that to the server: the MCP handshake is the same with the channel on or off, and a
 * notification sent while it is off is dropped without a word. So the server reads the `claude`
 * process's own command line and applies the gate Claude Code applies to it (as of 2.1.287): the
 * entry must be named by `--channels` or, in an interactive session,
 * `--dangerously-load-development-channels`; a plugin entry must name the marketplace the plugin
 * is installed from; and a `--channels` entry must be allowlisted, which for this plugin means an
 * organization's `allowedChannelPlugins` in managed settings, since it is not on Anthropic's own
 * list. Claude Code's account and provider checks are not repeated here.
 */
export type ChannelGate =
  | { readonly loaded: true }
  | { readonly loaded: false; readonly why: string }

/** One `plugin:<name>@<marketplace>` or `server:<name>` entry of either channel flag. */
export interface ChannelEntry {
  readonly kind: "plugin" | "server"
  readonly name: string
  readonly marketplace?: string
  readonly dev: boolean
}

export interface AllowedChannelPlugin {
  readonly marketplace: string
  readonly plugin: string
}

/** The flags that name channels, and whether each is the development one. */
const CHANNEL_FLAGS: Readonly<Record<string, boolean>> = {
  "--channels": false,
  "--dangerously-load-development-channels": true,
}

function parseEntry(value: string, dev: boolean): ChannelEntry | undefined {
  if (value.startsWith("plugin:")) {
    const spec = value.slice("plugin:".length)
    const at = spec.indexOf("@")
    if (at <= 0 || at === spec.length - 1) return undefined
    return { kind: "plugin", name: spec.slice(0, at), marketplace: spec.slice(at + 1), dev }
  }
  if (value.startsWith("server:") && value.length > "server:".length) {
    return { kind: "server", name: value.slice("server:".length), dev }
  }
  return undefined
}

/**
 * The channel entries a `claude` command line names, parsed as Claude Code parses them: each flag
 * takes the values after it up to the next option, or one inline `=` value, and untagged values are
 * dropped. Development channels load only in an interactive session, so `-p` drops them, but only
 * when `exact`: a command line split on whitespace (`ps`) cannot tell a `-p` flag from one inside
 * a prompt, and dropping a loaded channel there would refuse messages the session takes.
 */
export function claudeChannelEntries(argv: readonly string[], exact = true): ChannelEntry[] {
  const interactive = !exact || (!argv.includes("-p") && !argv.includes("--print"))
  const entries: ChannelEntry[] = []
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? ""
    const equals = argument.indexOf("=")
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    const dev = CHANNEL_FLAGS[flag]
    if (dev === undefined) continue
    const values: string[] = []
    if (equals !== -1) values.push(argument.slice(equals + 1))
    else {
      while (index + 1 < argv.length && !(argv[index + 1] ?? "-").startsWith("-")) {
        values.push(argv[index + 1] ?? "")
        index++
      }
    }
    if (dev && !interactive) continue
    for (const value of values) {
      const entry = parseEntry(value, dev)
      if (entry !== undefined) entries.push(entry)
    }
  }
  return entries
}

/** A process's command line: its arguments, and whether they are exact (`/proc`) rather than
 *  `ps` output split on whitespace. */
export interface CommandLine {
  readonly argv: readonly string[]
  readonly exact: boolean
}

/**
 * Whether the `claude` process with `commandLine` loads this server's channel. An undefined
 * command line could not be read, and is taken as loaded: that is what the server advertised
 * before it could tell, and refusing every message on a guess would be worse.
 */
export function claudeChannelGate(input: {
  readonly commandLine: CommandLine | undefined
  /** This plugin's name and, when the install path says it, its marketplace; undefined when the
   *  server runs from a bare MCP config rather than as a plugin, where only `server:` entries
   *  apply (a plugin's server is `plugin:<name>:<server>`, which no `server:` entry names). */
  readonly plugin: { readonly name: string; readonly marketplace: string | undefined } | undefined
  /** The managed settings' `allowedChannelPlugins`, or undefined when they do not set it. */
  readonly allowlist: readonly AllowedChannelPlugin[] | undefined
}): ChannelGate {
  const { commandLine, plugin, allowlist } = input
  if (commandLine === undefined) return { loaded: true }
  const ours =
    plugin === undefined
      ? "server:<name>"
      : `plugin:${plugin.name}@${plugin.marketplace ?? "<marketplace>"}`
  // A bare config's own server name is not known here, so any `server:` entry counts for it.
  const entry = claudeChannelEntries(commandLine.argv, commandLine.exact).find((candidate) =>
    plugin === undefined
      ? candidate.kind === "server"
      : candidate.kind === "plugin" && candidate.name === plugin.name,
  )
  if (entry === undefined) {
    return {
      loaded: false,
      why: `claude was started without --channels ${ours} (or --dangerously-load-development-channels ${ours})`,
    }
  }
  if (entry.kind === "server") {
    return entry.dev
      ? { loaded: true }
      : {
          loaded: false,
          why: `server:${entry.name} is not on Claude Code's approved channels allowlist (use --dangerously-load-development-channels server:${entry.name})`,
        }
  }
  const asked = `plugin:${entry.name}@${entry.marketplace}`
  if (plugin?.marketplace !== undefined && entry.marketplace !== plugin.marketplace) {
    return {
      loaded: false,
      why: `claude asked for ${asked} but this plugin is installed from ${plugin.marketplace}`,
    }
  }
  if (entry.dev) return { loaded: true }
  if (allowlist === undefined) {
    return {
      loaded: false,
      why: `${asked} is not on Claude Code's approved channels allowlist (an organization adds it with allowedChannelPlugins in managed settings; for one session use --dangerously-load-development-channels ${asked})`,
    }
  }
  return allowlist.some(
    (allowed) => allowed.marketplace === entry.marketplace && allowed.plugin === entry.name,
  )
    ? { loaded: true }
    : {
        loaded: false,
        why: `${asked} is not on your organization's approved channels list (allowedChannelPlugins in managed settings)`,
      }
}

/** The executable process `pid` runs, or undefined when it cannot be read. */
export function processExecutable(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/exe`)
    } catch {
      return undefined
    }
  }
  if (process.platform === "win32") return undefined
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
    encoding: "utf8",
    timeout: 2_000,
  })
  const first = (result.stdout ?? "").split("\n").find((line) => line.startsWith("n"))
  return first === undefined ? undefined : first.slice(1)
}

/**
 * The command line of process `pid`, or undefined when it cannot be read: `/proc` on Linux
 * (exact), `ps` elsewhere (split on whitespace, which no channel entry contains), and nothing on
 * Windows. Claude Code sets `process.title` to `claude`, which under Node overwrites the arguments
 * `ps` and `/proc` show, so a one-word command line from a Node process cannot be read either; a
 * native (Bun) build keeps its arguments, and its one-word command line means `claude` alone.
 */
export function processCommandLine(
  pid: number,
  executable: (pid: number) => string | undefined = processExecutable,
): CommandLine | undefined {
  let commandLine: CommandLine | undefined
  if (process.platform === "linux") {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter((argument) => argument !== "")
      commandLine = argv.length === 0 ? undefined : { argv, exact: true }
    } catch {
      commandLine = undefined
    }
  } else if (process.platform !== "win32") {
    const result = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000,
    })
    const line = result.status === 0 ? result.stdout.trim() : ""
    commandLine = line === "" ? undefined : { argv: line.split(/\s+/), exact: false }
  }
  if (commandLine === undefined || commandLine.argv.length > 1) return commandLine
  const program = basename(executable(pid) ?? "")
  return program === "node" || program === "nodejs" ? undefined : commandLine
}

/**
 * The marketplace a plugin install path names (`…/plugins/cache/<marketplace>/<plugin>/…`), or
 * undefined for any other path: a source checkout, `--plugin-dir`, or a bare server config.
 */
export function installedMarketplace(bundlePath: string): string | undefined {
  const parts = bundlePath.split(sep)
  for (let index = 0; index + 2 < parts.length; index++) {
    if (parts[index] === "plugins" && parts[index + 1] === "cache") return parts[index + 2]
  }
  return undefined
}

const ManagedChannelSettings = z.object({
  allowedChannelPlugins: z
    .array(z.object({ marketplace: z.string(), plugin: z.string() }))
    .optional(),
})

/** Claude Code's managed settings directory on this platform. */
export function managedSettingsDirectory(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode"
    case "win32":
      return "C:\\Program Files\\ClaudeCode"
    default:
      return "/etc/claude-code"
  }
}

/** A settings file's `allowedChannelPlugins` (`list`), or undefined when the file is missing, is
 *  not a JSON object, or (with `nonEmpty`) is an empty one. */
function readChannelSettings(
  file: string,
  nonEmpty = false,
): { readonly list: readonly AllowedChannelPlugin[] | undefined } | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    if (nonEmpty && Object.keys(value).length === 0) return undefined
    const parsed = ManagedChannelSettings.safeParse(value)
    return { list: parsed.success ? parsed.data.allowedChannelPlugins : undefined }
  } catch {
    return undefined
  }
}

/**
 * The `allowedChannelPlugins` of the managed settings Claude Code applies, read from files. Its
 * managed tier is "first-wins" by default: the highest-priority source present is the tier alone -
 * server-managed settings (cached as `remote-settings.json` in the config directory), then an MDM
 * profile or the Windows registry, then `managed-settings.json` with its `managed-settings.d`
 * drop-ins. Undefined when the winning source does not set the key, or none is present, which
 * leaves Claude Code's own list. MDM and registry settings are not read; `ENVOY_CHANNEL_LOADED=1`
 * covers an allowlist only they deliver.
 */
export function channelAllowlist(directories: {
  readonly managedDirectory: string
  readonly configDirectory: string
}): readonly AllowedChannelPlugin[] | undefined {
  const remote = readChannelSettings(
    join(directories.configDirectory, "remote-settings.json"),
    true,
  )
  if (remote !== undefined) return remote.list
  const dropIns = join(directories.managedDirectory, "managed-settings.d")
  let dropInFiles: string[] = []
  try {
    dropInFiles = readdirSync(dropIns)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => join(dropIns, name))
  } catch {
    dropInFiles = []
  }
  const lists = [join(directories.managedDirectory, "managed-settings.json"), ...dropInFiles]
    .map((file) => readChannelSettings(file)?.list)
    .filter((list) => list !== undefined)
  return lists.length === 0 ? undefined : lists.flat()
}

/**
 * Whether this server's channel is loaded, for the `claude` process `claudePid` running the bundle
 * at `bundlePath`: as a plugin when Claude Code set `CLAUDE_PLUGIN_ROOT`, else from a bare MCP
 * config. `ENVOY_CHANNEL_LOADED=1` or `0` overrides the check.
 */
export function detectClaudeChannel(input: {
  readonly claudePid: number
  readonly bundlePath: string
  readonly environment: NodeJS.ProcessEnv
}): ChannelGate {
  const override = input.environment["ENVOY_CHANNEL_LOADED"]?.trim()
  if (override === "1") return { loaded: true }
  if (override === "0") return { loaded: false, why: "ENVOY_CHANNEL_LOADED=0" }
  const configDirectory =
    input.environment["CLAUDE_CONFIG_DIR"]?.trim() || join(homedir(), ".claude")
  const plugin = input.environment["CLAUDE_PLUGIN_ROOT"]?.trim()
    ? { name: "claude-envoy", marketplace: installedMarketplace(input.bundlePath) }
    : undefined
  return claudeChannelGate({
    commandLine: processCommandLine(input.claudePid),
    plugin,
    allowlist: channelAllowlist({ managedDirectory: managedSettingsDirectory(), configDirectory }),
  })
}
