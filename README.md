# interpretle

[Play interpretle.com](https://interpretle.com). Find text that activates a hidden
feature in a language model. Reach the 99.9th percentile within six attempts,
with at most two custom sentences. A highlighted passage near the median is your
free starting clue. Daily puzzles roll over at midnight Pacific time, including
daylight saving time; the day dropdown
opens the archive. Practice keeps separate progress.
Games started before the six-attempt update keep their original limit.

The game is served as **static files**, configured in [wrangler.jsonc](wrangler.jsonc).
The backend is [a small daily solve counter](server/results.ts) and
[first-party game counters](server/analytics.ts). Daily results use one
Cloudflare Durable Object per puzzle day, with eight solve counts, an X bucket
for games that exhausted all attempts, and random
submission IDs to avoid counting reloads twice. They store no text or scores and
does no inference. Results are browser-reported, not a verified leaderboard.
The counter begins collecting when deployed; older saved results are included
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

Generate the ignored browser weight chunks with `python scripts/export_browser.py --fp4`
before deploying a fresh checkout. After authenticating your Cloudflare account,
`npm run deploy` verifies those assets and publishes the site and its counter to
`interpretle.com`. Credentials
stay outside this repository. GitHub Actions runs checks; deployment is manual.
Keep the `no-transform` response header, which prevents automatic script injection
and preserves model integrity. Game progress and custom text stay in the player's browser.
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
with a maximum of 80 model tokens; five suggestions are followed by a write-in
card. For a positive maximum `a`, the percentile is
`100 × count(reference < a) / N`, where
the reference contains **positive passage maxima** from the fixed corpus.
Raw zero is inactive. Ties use the strict lower rank, and winning uses the
unrounded percentile. Sampling bands are approximate; displayed scores are
always calculated from actual activations.

The next choices follow the best sampling band reached so far. A passage labeled
50 unlocks the 50 band even if its measured percentile is 49.8. Write-ins use
their measured percentile. The free clue does not advance the board, and weaker
guesses never reduce progress.

| Best band        | Next five suggestions  |
| ---------------- | ---------------------- |
| Below 50         | 0, 0, 0, 50, 90        |
| 50 to below 90   | 0, 0, 50, 90, 99       |
| 90 to below 95   | 0, 50, 90, 95, 99.9    |
| 95 to below 99   | 50, 90, 95, 99, 99.9   |
| 99 to below 99.9 | 50, 95, 99, 99.9, 99.9 |

Daily targets are curated SAE features. Practice also uses positive residual
coordinates (`max(0, hidden[index])`) and gated MLP neurons
(`max(0, gelu(gate_proj(x)) * up_proj(x))`, before layer 21's output projection).
The feature description is
revealed when the game ends, with optional model and SAE details after a solve.
Data and answers are inspectable in this static
game; it does not attempt to prevent cheating.

The library has **30 curated daily concepts**. Its separate practice pool has
48 experimental SAE features spread across all four quarters of the 65,536-feature
dictionary, eight MLP neurons, and one residual coordinate. No daily SAE feature
is used in that practice pool. Published daily assignments and their original
measurements stay fixed as the library expands.

## Custom sentences

Custom scoring is WebGPU inference on the player's device. Opening the page starts
preparing the model prefix and complete SAE encoder in the background, about **3.08 GB** on the first visit,
and caches it in browser storage. Stored passages remain playable during background loading.
Focusing the write-in card joins that download and shows progress beside a Cancel
button. Type directly into the card; Enter submits and Shift+Enter adds a newline.
Enter during loading waits for the model to be ready. Each puzzle allows two write-ins.
It needs a compatible GPU with FP16 support and enough storage. Loading,
cancelled runs, unsupported devices, and failed inference do not consume an
attempt. The passage game also works on devices that cannot load the model.

The browser runs small ONNX graphs one layer at a time. It uses only layers 0–21,
with the unused layer-specific embedding columns removed. Matrix weights use
block-scaled FP4 E2M1; normalization parameters retain their original precision.
All **65,536 FP32 SAE encoder rows**, biases, and thresholds are cached together
with the shared input bias. This adds about **672 MB**, letting future features
reuse the same download. The SAE decoder matrix and later model layers are omitted.
Only the selected encoder row is read into memory for scoring.
The tokenizer and all model parameters are hosted as Cloudflare static assets;
players no longer need Hugging Face requests. The tokenizer JSON is losslessly
minified to fit Cloudflare's per-file limit. Downloads retry temporary failures
and reuse verified, completed chunks after a retry or browser restart. Browser
storage can still be cleared or evicted by the browser.
The catalog selects the [versioned FP4 manifest](public/model/manifest-v3-fp4.json).
Original manifest and graph URLs remain available for already-open older tabs.

Stored passages and percentile reference arrays retain **the original model's
full-quality scores**. Only local write-ins use FP4 and display `≈` to identify
their estimated scores. The approximation can change activations and win decisions;
see the [measured FP4/FP8 comparison](docs/validation.md#quantization).

The client checks download hashes and never contacts an
inference service. All required weight chunks are downloaded **before** looking
up input tokens, so input-dependent embedding requests cannot disclose text.
Packed weights are restored to FP16 for inference, with FP32 matrix accumulation
and reductions. Quantization reduces the download, not the GPU's computation precision.
The ONNX Runtime binary is loaded from a version-pinned CDN during preparation.
Custom text is scored as a complete document with a BOS token and no chat
template. Unlike a source excerpt, it has no preceding source context.
See [validation and reproduction steps](docs/validation.md) for the native and
browser scoring checks and their limits.

## Gameplay analytics

The game counters use a random first-party browser ID in local storage to
recognize returning players, plus a session ID in session storage. They count
visits, puzzle views, starts, selected public passage IDs/positions/bands,
attempt numbers, completed outcomes, practice rounds, write-in selections,
shares, and model loading outcomes. Model errors use fixed categories, never
raw error messages. No custom text, tokens, activation values, IP addresses,
or fingerprints are stored by this counter.

The backend keeps aggregate dimensions, daily per-browser visit/practice counts,
first-visit dates, and opaque event hashes for deduplication. It does not keep
a raw click history. Browser-reported counters are approximate and may be blocked.
The private [stats page](https://interpretle.com/admin) uses HTTP Basic
authentication over HTTPS, with username `henry` and a password stored only in the
`STATS_PASSWORD` Worker secret. Set or rotate it with `npx wrangler secret put
STATS_PASSWORD`. An unset password denies all access. Reports use private,
non-cacheable responses; there is no public gameplay stats API.

Reports include unique/returning browsers, visits, a practice-round histogram per
browser, and event counts broken down by the applicable public dimensions.
The existing daily solve histogram remains separate and excludes practice.

## Rebuild the data

Offline extraction needs a CUDA GPU; the deployed site does not. Install the
Python dependencies from `requirements.txt` in an isolated Python 3.13
environment, then run:

```sh
python scripts/prepare_corpus.py
python scripts/verify_model.py
python scripts/extract.py --output artifacts/activations-full
python scripts/build_puzzles.py --cache artifacts/activations-full --discover
# Inspect artifacts/activations-full/discovery.json and curate data/features.json.
python scripts/build_puzzles.py --cache artifacts/activations-full
python scripts/export_browser.py --fp4
```

The corpus mixes complete OpenAssistant conversations, TinyStories, MBPP Python
problems, and Wikipedia articles. Documents longer than 1,024 tokens are skipped,
not truncated. Extraction scans all 65,536 SAE features by default and stores
sparse activations, residual coordinates, selected gated MLP neurons,
token IDs, and original offsets. The large intermediate cache lives in ignored
`artifacts/`. The repository contains measured game packs and small model graphs;
derived weight chunks live in ignored `public/model/weights/` and are served as
static Cloudflare assets. The deployment check refuses missing or altered chunks.
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
