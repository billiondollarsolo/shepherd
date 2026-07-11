# Session concurrency ownership

The session package has one lock domain per `Session`; it deliberately does not
share a package-global lifecycle lock.

- `Session.mu` owns the current `ptmx`/`cmd`, subscriber map and ids, lifecycle
  flags, exit code, alternate-screen parser state, and finalization. Code must not
  perform blocking channel sends, process waits, sleeps, filesystem work, or PTY
  close while holding it.
- `ring.mu` owns only the bounded scrollback bytes. A caller may snapshot the ring
  while holding `Session.mu`, but ring code never calls back into a Session and
  therefore cannot reverse the order.
- Atomic counters own dropped-output bytes and last-activity time. Readers do not
  acquire `Session.mu` merely for telemetry.
- The PTY pump is the only goroutine that reads a PTY. `Write` and `Resize` take a
  short Session lock to select the current PTY; a dev restart swaps it under the
  same lock.
- Broadcast snapshots subscribers while locked and performs non-blocking sends.
  A slow subscriber drops bytes and increments the bounded diagnostic counter; it
  can never stall the PTY pump.
- `closeCh` is closed once by `Close`; it interrupts restart backoff. `done` is
  closed once by finalization after the pump drains. Subscription close is
  idempotent and removes its channel under `Session.mu`.
- ACP state has its own protocol goroutine and synchronization in
  `acp_session.go`; it communicates status through callbacks and never takes
  `Session.mu` while waiting on the ACP process.

Lock-order rule: if both are ever needed, acquire `Session.mu` before `ring.mu`.
No other package lock may be held while acquiring either. Race tests are the
enforcement gate for lifecycle, subscribe/fan-out, resize, and restart changes.
