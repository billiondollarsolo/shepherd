# Agent environment and credential grants

Flock constructs every agent environment explicitly. A session does not inherit the
orchestrator or secure agentd service environment.

## Categories

| Category                  | Examples                                                                           | Agent behavior                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Control-only              | master key, database URL, agentd credentials, Docker/SSH sockets, loader variables | Always removed, including when supplied in node environment settings                 |
| Session capability        | `FLOCK_HOOK_TOKEN`, `FLOCK_ORCHESTRATE_TOKEN`, session ID and callback URL         | Created by the orchestrator for one session; node settings cannot spoof them         |
| Provider credential grant | Anthropic, OpenAI, Gemini/Google, xAI, Cursor, and Amp API keys                    | Passed only to the compatible coding-agent types listed below                        |
| Operator environment      | Build flags, proxy settings, project configuration                                 | Explicit node configuration; visible to every matching session launched on that node |

Provider grants currently map as follows:

- `ANTHROPIC_API_KEY`: Claude Code, OpenCode, Aider
- `OPENAI_API_KEY`: Codex, OpenCode, Aider
- `GEMINI_API_KEY` and `GOOGLE_API_KEY`: Gemini, OpenCode
- `XAI_API_KEY`: Grok, OpenCode
- `CURSOR_API_KEY`: Cursor Agent
- `AMP_API_KEY`: Amp

Unknown operator-defined variables are treated as ordinary node configuration. They
are not assumed secret and are visible to every agent launched on that node. Use a
known provider key for provider credentials and avoid putting unrelated secrets in
node environment settings.

## Temporary files

Each PTY and ACP session receives its own `TMPDIR`, `TMP`, and `TEMP` directory at
`$HOME/.flock/tmp/<session-id>`. Agentd creates it with mode `0700`, assigns it to the
reduced agent identity, overrides any node-supplied temp path, and removes it when the
session finalizes. This isolates ordinary tool temporary files; it is not a substitute
for Landlock or OS-user privilege separation.

## Token handling

Hook scripts read callback values from the session environment at execution time. No
generated command string embeds a plaintext token. Flock never returns callback or
orchestration tokens to the browser, persists only hashes, and revokes orchestration
capabilities when a session closes.
