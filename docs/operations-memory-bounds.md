# Runtime collection and memory bounds

Every process-lifetime collection is either limited by active durable entities and
explicit lifecycle cleanup, or has a hard maximum and expiry. This inventory is part
of the architecture contract; adding a long-lived map, set, queue, cache, waiter, or
scrollback buffer requires updating this table and diagnostics.

| Owner            | Collection                             | Hard bound / TTL                            | Cleanup and overload behavior                                                          |
| ---------------- | -------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| HTTP             | global request budget keys             | 10,000 keys / request window                | TTL sweep; oldest keys evicted; excess requests rejected                               |
| Auth             | durable login throttle rows            | 50,000 rows / 30-minute idle TTL by default | PostgreSQL pruning; oldest rows evicted; lockouts survive restarts                     |
| Hooks            | last emitted plan                      | 5,000 sessions / 24 hours                   | explicit delete on termination plus TTL/oldest eviction                                |
| Hooks            | OpenCode chat sessions                 | 5,000 active sessions                       | explicit `forget`; oldest session evicted                                              |
| Hooks            | OpenCode roles/parts                   | 2,000 messages and 4,000 parts per session  | oldest entries and matching emitted IDs evicted                                        |
| Orchestration    | spawn windows                          | 5,000 projects / 60 seconds                 | empty windows swept; oldest project evicted                                            |
| Runtime          | agent telemetry                        | 10,000 sessions / 24 hours                  | delete on termination; TTL/oldest eviction                                             |
| Runtime          | daemon probes                          | 5,000 nodes / 15 seconds                    | TTL/oldest eviction                                                                    |
| Runtime          | sandbox capability                     | 5,000 nodes / 24 hours                      | TTL/oldest eviction                                                                    |
| Diagnostics      | recent events/counters                 | 200 events / 500 counter keys               | oldest entries evicted; no high-cardinality growth                                     |
| Events           | write-behind rows                      | 10,000 rows                                 | oldest row dropped and counted; retries are finite                                     |
| Live channels    | sessions/status/fallbacks              | open sessions only                          | `untrackSession` removes all entries and PTY state                                     |
| Project Preview  | project services/origins/token digests | 16 forwards; 32 connections each by default | expiry/revoke/project or node removal destroys tunnels; restart clears active forwards |
| Node connections | SSH connections/connect attempts       | configured nodes only                       | node delete/disconnect and process shutdown remove entries                             |
| Status WS        | clients                                | connected sockets only                      | close/error/heartbeat timeout removes entries                                          |
| PTY event queue  | pending waiters                        | active drain callers only                   | resolved together when drain empties; shutdown rejects no new work                     |
| agentd           | PTY scrollback                         | configured byte ring per live session       | oldest bytes overwritten; session close frees ring                                     |

`BoundedTtlMap` has deterministic fake-clock and 10,000-key churn tests. Preview,
event, request-budget, login, orchestration, and agentd collections retain focused
unit/integration tests. The authenticated diagnostics bundle reports current
low-cardinality sizes without exposing session content.
