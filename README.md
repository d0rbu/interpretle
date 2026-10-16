# interpretle

[Play interpretle.com](https://interpretle.com). Find text that activates a hidden
feature in a language model. Reach the 99.9th percentile within eight attempts,
with at most two custom sentences. A highlighted passage near the median is your
free starting clue. Daily puzzles roll over at midnight UTC; the day dropdown
opens the archive. Practice keeps separate progress.

The game is served as **static files**, configured in [wrangler.jsonc](wrangler.jsonc).
The only backend is [a small daily solve counter](server/results.ts): one
Cloudflare Durable Object per puzzle day, with eight aggregate counts and random
submission IDs to avoid counting reloads twice. It stores no text or scores and
does no inference. Results are browser-reported, not a verified leaderboard.
The counter begins collecting when deployed; older saved solves are included
when those players return. Practice does not contribute to daily counts.

## Develop and deploy

Use Node 24 or newer:

```sh
npm ci
npm run dev
```

```sh
npm run check
npx playwright install chromium
npm run test:e2e
npm run deploy:check
```

After authenticating your Cloudflare account, `npm run build` followed by
`npx wrangler deploy` publishes the site and its counter to `interpretle.com`. Credentials
stay outside this repository. GitHub Actions runs checks; deployment is manual.
Keep the `no-transform` response header, which prevents automatic analytics
injection. Game progress and custom text stay in the player's browser; only a
per-puzzle random ID and number of attempts are sent when a daily puzzle is solved.
To run the counter locally, build the site and run `npx wrangler dev`.

## Scores

Stored passages are measured offline with
[Gemma 4 E4B](https://huggingface.co/google/gemma-4-E4B), decoder layer 21, and
[Decode Research's SAE](https://huggingface.co/decoderesearch/gemma-4-saes).
The checkpoint revisions, corpus identity, population sizes, and pack hashes are
published in [the data provenance](public/puzzles/provenance.json).

The model reads each complete source document. We then split its stored token
activations into displayed passages. Only a passage's own tokens contribute to
its heatmap and maximum. The chevron reveals up to 64 preceding model tokens,
without additional scores. The passage moves into its expanded position and
becomes bold; devices requesting reduced motion skip the animation.
Suggested passages favor two or three sentences,
with a maximum of 80 model tokens; seven suggestions are followed by a write-in
card. For a positive maximum `a`, the percentile is
`100 × count(reference < a) / N`, where
the reference contains **positive passage maxima** from the fixed corpus.
Raw zero is inactive. Ties use the strict lower rank, and winning uses the
unrounded percentile. Sampling bands are approximate; displayed scores are
always calculated from actual activations.

Daily targets are curated SAE features. Practice can also use positive residual
coordinates (`max(0, hidden[index])`) at the same hook. The feature description is
revealed when the game ends, with optional model and SAE details after a solve.
Data and answers are inspectable in this static
game; it does not attempt to prevent cheating.

The initial library has 14 curated SAE features and one experimental coordinate.
The daily catalog rotates these targets; practice uses a fresh passage order.

## Custom sentences

Custom scoring is WebGPU inference on the player's device. Focusing the write-in
card automatically downloads and loads the model prefix, 11.2 GB on first use,
and caches it in browser storage. Type directly into the card; Enter submits and
Shift+Enter adds a newline. Enter during loading waits for the model to be ready.
Download and inference progress appear inside the card, beside a Cancel button.
It needs a compatible GPU with FP16 support and enough storage. Loading,
cancelled runs, unsupported devices, and failed inference do not consume an
attempt. The passage game works without downloading any model.

The browser runs small ONNX graphs one layer at a time. It reads weights from
the pinned public checkpoint, checks download hashes, and never contacts an
inference service. All required weight chunks are downloaded **before** looking
up input tokens, so input-dependent embedding requests cannot disclose text.
Weights and hidden states use FP16, with FP32 matrix accumulation and reductions.
The ONNX Runtime binary is loaded from a version-pinned CDN only after opt-in.
Custom text is scored as a complete document with a BOS token and no chat
template. Unlike a source excerpt, it has no preceding source context.
See [validation and reproduction steps](docs/validation.md) for the native and
browser scoring checks and their limits.

## Rebuild the data

Offline extraction needs a CUDA GPU; the deployed site does not. Install the
Python dependencies from `requirements.txt` in an isolated Python 3.13
environment, then run:

```sh
python scripts/prepare_corpus.py
python scripts/verify_model.py
python scripts/extract.py
python scripts/build_puzzles.py --discover
# Inspect artifacts/activations/discovery.json and curate data/features.json.
python scripts/build_puzzles.py
python scripts/export_browser.py
```

The corpus mixes complete OpenAssistant conversations, TinyStories, MBPP Python
problems, and Wikipedia articles. Documents longer than 1,024 tokens are skipped,
not truncated. Extraction stores sparse SAE activations, neuron coordinates,
token IDs, and original offsets. The large intermediate cache lives in ignored
`artifacts/`; only curated game packs and small model graphs are published.
See [data sources and licenses](docs/data.md).

| File                         | Purpose                                      |
| ---------------------------- | -------------------------------------------- |
| `src/App.tsx`                | Header, instructions, and game board         |
| `src/lib/game.ts`            | Rounds, budgets, daily progress, and results |
| `src/components/Heatmap.tsx` | Actual model-token highlights                |
| `src/lib/model.worker.ts`    | Optional local model execution               |
| `src/lib/model-cache.ts`     | Fixed, verified model downloads              |
| `scripts/`                   | Offline extraction and static export         |
| `public/puzzles/`            | Measured puzzle packs and provenance         |

Application code is MIT-licensed. Source passages and model weights retain their
own licenses; the application license does not relicense those materials.
