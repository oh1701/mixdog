# Computer Use module boundaries

This layout preserves the existing public tool schema.

- `observation/capture.ts` sequences a capture and owns its semantic baseline.
  `capture-pixels.ts` acquires window-owned pixels and zooms; `capture-ocr.ts`
  budgets and merges OCR; `capture-result.ts` shapes the observation;
  `capture-after.ts` preserves post-action capture preferences and recovery.
- `host/command-router.ts` owns ordering, target resolution, leases, invalidation
  and transitions. `input-dispatch.ts` authorizes immediately before delivery;
  `action-reply.ts` interprets evidence and attaches the resulting observation.
- `host/input-preflight.ts` shares keyboard normalization and app-owned text
  route selection with dispatch. Preflight sends no text and validates all
  native keyboard steps before the first mutation; dispatch still checks the
  live target and authority. A completed preparatory click remains possible
  input even if the later text operation is refused.
- `src/runtime/computer-bridge/actions.mjs` is the shared action catalogue.
  Public replay safety, native read-only status, reference retention, foreground
  serialization, observation requirements and policy names are distinct flags.
  Unknown actions never acquire read/replay privileges.
- `backend/sources/` holds editable C# and PowerShell originals. Tiny TypeScript
  adapters render only named placeholders. Source execution reads these files;
  `scripts/computer-source-assets.mjs` embeds them in both Vite desktop builds
  and esbuild harness bundles. Installed execution needs no loose source files.

## Tests

### macOS target input protection (implemented; native acceptance pending)

Window captures bracket reads with both global and target-scoped input
observations. Unrelated app activity invalidates foreground authority but not
background authority. `input_idle_state(window_id)` retains its global fields
and adds `target_observation`; background target mutations and sequence
envelopes carry `observed_target_input_monitor_id` and
`observed_target_input_user_sequence`. The same session worker owns both reads
and delivery. Worker replacement requires a fresh capture.

The macOS listen-only annotated event tap uses event destination process IDs,
bound to process start identity, rather than inferring past input from current
focus. Same-process auxiliary windows and verified direct parent/child
processes share interruption protection. Unknown attribution, event-tap gaps,
secure input, and target disappearance refuse input. Observer gaps remain
latched until observer replacement; Resume alone does not repair them.
Foreground retains its global input guard. Windows/Linux are unchanged.

An interrupted command is never replayed. Pending owned releases are attempted
only against the original process; Quartz posting cannot acknowledge delivery,
so required cleanup reports `computer_background_cleanup_unconfirmed` and
requires manual recovery. Standalone background mouse holds are refused.
macOS app-owned text uses the guarded native path, never unguarded Electron
`insertText` or automatic foreground fallback.

Native compilation and 25 unit tests pass on macOS with an isolated Rust
toolchain. Two-app physical-input acceptance remains pending. In particular,
ordinary event destination availability, asynchronous event
delivery, and brief secure-input intervals between checks are not proven by
the isolated tests. This implementation is not release-qualified until these
limitations are resolved or verified.

Fast behavior/contract tests use `*.test.mjs`. Worker process lifecycle, native
compilation and Windows fixture execution use `*.slow.test.mjs`. Native fixtures
live under `host/fixtures/`, separate from assertion code.

`clipboard.live.test.mjs` is opt-in and additionally requires
`MIXDOG_COMPUTER_LIVE_CLIPBOARD=1`. Do not enable it as part of an isolated check.
It accesses the real clipboard and attempts to restore its original contents.

`backend/source-bundle.test.mjs` executes Vite and esbuild outputs from a
temporary directory without adjacent source assets, and compares the generated
host program to source execution. This catches missing build-plugin wiring
without launching the desktop app or interacting with a user window.

See `computer-use-parity.md` for reference comparisons, deliberate policy
differences, and the installed-app acceptance that source tests cannot replace.
