# Agent control (master improvement plan H2.4)

When agentd advertises `agent_control_v1` / `screendetect_v1`:

| CLI | agentd op |
| --- | --- |
| `shep-tui sessions explain <id>` | `statusExplain` |
| `shep-tui sessions prompt <id> --text ...` | `session.prompt` |
| `shep-tui sessions wait <id> --for idle\|done\|needs-you` | server-side `session.wait_status` when `agent_control_v1` present; else poll status |

Screendetect is **on by default** in agentd (product default after fixture gate). Explicit kill-switch: `FLOCK_SCREENDETECT=0|false|off|no`.
