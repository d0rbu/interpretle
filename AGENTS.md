# Interpretle

Keep this project small and easy to read. There is a very high bar for adding
complexity and a low bar for removing it.

- Serve the game as static files. Backend exceptions are the small daily
  results counter and first-party gameplay counters in `server/`, requested by the user.
  Keep them limited to aggregates and a private, timestamped event history with
  random browser IDs, server-derived visitor IPs, device/model diagnostics,
  submitted write-ins, and the boards/token scores needed to replay games.
  Bounded exception messages, stacks and runtime breadcrumbs are private too.
  Per-forward-pass wall-clock timings, including overlapping weight preparation,
  are private telemetry too; do not add GPU synchronization just for profiling.
  Unsubmitted drafts are not collected. No server inference
  or game-session service. Only the private stats page needs
  authentication, using a Worker secret.
- Run the selected dataset through the model and SAE **offline**, preserving
  per-token activations. Also support neuron/activation targets with explicit
  hook, coordinate, and sign conventions.
- Offline extraction uses **full source context**. Show scores/highlights only
  for the displayed passage and take its maximum over that span. Expanded
  context is readable text without extra scores. Do not re-score isolated excerpts.
- Suggested passages use stored activations. Custom passages must run locally
  in the player's browser via WebGPU, with a WebAssembly CPU fallback. Never add
  a server inference fallback.
- Do not replace the requested base model with an instruction-tuned model or a
  different quantization without validating the activation/scoring contract.
- Publish only measured activations and actual tokenizer offsets. Numerical
  fixtures belong in tests and must never be imported by application code.
- Daily puzzles use curated SAE features. Practice may use experimental targets.
- Preserve the six-attempt limit (preserving older saved games), two-custom limit, free 50th-percentile clue,
  positive-passage percentile definition, and per-token feedback.
- Use Node 24+. Run `npm run check` and the relevant Playwright checks. UI changes
  should be inspected on desktop and mobile. Do not rent GPUs or run a full
  corpus pass merely to validate a UI change.
