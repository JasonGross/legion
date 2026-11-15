# Envoy for the Codex CLI

`@sjawhar/codex-envoy` is Legion's Envoy and Dispatch plugin for the Codex CLI.
A Codex session that loads it registers with Envoy under its own session id and shows on Dispatch's
Agents page with a live view of its conversation.
Messages sent to it from the Agents page (Aside, BTW and Steer) and messages on Dispatch issues
routed to it arrive in its conversation, and its `dispatch` tool runs the `dispatch` command as
the session.
It ships the Dispatch skills.

```bash
codex plugin marketplace add cybermonklabs/legion
codex plugin add codex-envoy@legion-plugins
```

It is built from the same source as the Claude Code plugin, `@sjawhar/claude-envoy`, whose README
describes both hosts: https://github.com/cybermonklabs/legion/tree/main/packages/claude-envoy
