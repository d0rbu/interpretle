# The whole backend

**There is no application backend. Cloudflare serves files.**

```text
OFFLINE
mixed corpus -> model activations -> SAE features / neuron coordinates
             -> token activation cache + calibration + static puzzle packs

STATIC HOSTING
app files + puzzle packs + browser model/feature assets

PLAYER'S BROWSER
daily seed -> sample stored passages -> reveal stored token highlights
custom text -> local WebGPU forward pass -> token highlights
game rules + saved progress -> localStorage
```

The complete hosting configuration is `wrangler.jsonc` plus the static response header in `public/_headers`, which prevents automatic analytics injection. The prototype is live at [interpretle.com](https://interpretle.com). Keep hosting limited to static files unless a concrete user need justifies something more.

## Data

An offline dataset pass records actual token activations for both target families:

- **SAE:** model/revision, hook, SAE/revision, latent index, encoder convention.
- **Neuron/activation:** model/revision, hook, coordinate, pre/post-nonlinearity and sign convention.

Store sparse SAE activations sparsely; avoid a dense `tokens × 65,536` file. Neuron coordinates can use a separate array in the same corpus cache. Run extraction with full source context. Keep tokenizer offsets, document provenance, the exact input context, the displayed-span offsets, and the attention/special-token mask. No need to duplicate source text per feature.

Build small static per-puzzle packs from that cache. A pack contains the target identity, the free clue, candidate passages, activations for their displayed tokens, frozen positive-passage calibration, display scale, and a short reveal. Include surrounding source text for reading, but its scores stay out of the game display and out of each passage maximum. The UI hides unplayed scores; the downloaded file is inspectable. This is an accepted simplicity tradeoff.

## Custom text

Use the **same activation contract** in the browser. A compact export can stop at layer 21 and emit the required activation, without a language-model output head or text generation. If exact exported inference allows selecting a target, ship only the selected SAE encoder column/bias/threshold alongside the truncated model; validate this against full SAE encoding before using it. Neuron coordinates use the chosen hook output directly.

Model weights load only after the player chooses to enable custom sentences. Show the download size and progress, cache assets, and keep the UI responsive with a Web Worker. This is a client-side worker, not a server service. Unsupported WebGPU, missing exports, and allocation failure disable custom scoring without consuming a guess; the eight stored choices still work. Never fall back to remote inference.

Quantization changes internal activations. Calibrate against the **same exported scorer**, or establish and measure an explicit parity tolerance on held-out examples. Sharing a model family name does not make two activation distributions interchangeable.

## Deliberately absent

No inference endpoint, accounts, server sessions, rate-limit service, database, leaderboard, background server jobs, queue, or anti-cheat service. Attempts and the two-custom limit are local game rules. Static hosting and local inference are the scaling strategy.

## What exists today

The static game, sampling, UI, and local progress are implemented. The current data is synthetic. Corpus inference, cache/pack generation, and a qualified Gemma WebGPU activation export are the next milestone; this document does not claim they have run.
