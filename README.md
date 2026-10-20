# interpretle

[Play interpretle.com](https://interpretle.com). Find text that activates a hidden
feature in a language model. Reach the 99.9th percentile within six attempts,
with at most two custom sentences. A highlighted passage near the median is your
free starting clue. Daily puzzles roll over at midnight Pacific time, including
daylight saving time; the day dropdown
opens the archive. Practice keeps separate progress.
Games started before the six-attempt update keep their original limit.

The game is served as **static files**, configured in [wrangler.jsonc](wrangler.jsonc).
The entry page passes through the Worker to redirect HTTP visitors to HTTPS
before any browser code runs. Model weights and other assets are served directly.
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
npx playwright install chromium webkit
npm run test:e2e
npm run deploy:check
```

Generate the ignored browser weight chunks with `python scripts/export_browser.py --fp4`
before deploying a fresh checkout, then run `python3 scripts/prepare_downloads.py`
on the active manifest to create resumable download pieces. After authenticating your Cloudflare account,
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

The upcoming rotation has **20 reviewed daily concepts**. Ten targets from the
previous pool are held back pending a clearer endgame. Starting clues are
reviewed against the token that actually activates, using measured passages in
the 45th–55th percentile window so relevance can take priority over an exact
median. [Curation notes](data/CURATION.md) describe the review criteria.
Its separate practice pool has
48 experimental SAE features spread across all four quarters of the 65,536-feature
dictionary, eight MLP neurons, and one residual coordinate. No daily SAE feature
is used in that practice pool. Published daily assignments and their original
measurements stay fixed as the library expands.

## Custom sentences

Custom scoring runs on the player's device, preferring WebGPU and falling back
to the CPU through WebAssembly when no compatible GPU is available. Opening the page starts
preparing the model prefix and complete SAE encoder in the background, about **3.1 GB** on the first visit,
and caches it in browser storage. Stored passages remain playable during background loading.
Focusing the write-in card joins that download and shows progress beside a Cancel
button. Type directly into the card; Enter submits and Shift+Enter adds a newline.
Enter during loading waits for the model to be ready. Each puzzle allows two write-ins.
After tokenization, the card shows the tokenizer's actual text spans with a loading
wave until scoring finishes. The wave is not an activation measurement; completed
guesses use the measured highlights. Reduced-motion settings disable the wave.
It needs enough browser storage and memory; a dedicated graphics card is not required.
CPU scoring can take longer, and stays in a worker so the game remains responsive. Loading,
cancelled runs, unsupported devices, and failed inference do not consume an
attempt. The passage game also works on devices that cannot load the model.

The browser runs small ONNX graphs with progress at each projection, attention,
and normalization step. These are partitions of the original graphs: each node
runs once, with the same weights and rounding. It uses only layers 0–21,
with the unused layer-specific embedding columns removed. Matrix weights use
block-scaled FP4 E2M1; normalization parameters retain their original precision.
All **65,536 FP32 SAE encoder rows**, biases, and thresholds are cached together
with the shared input bias. This adds about **672 MB**, letting future features
reuse the same download. The SAE decoder matrix and later model layers are omitted.
Only the selected encoder row is read into memory for scoring.
The tokenizer and all model parameters are hosted as Cloudflare static assets;
players no longer need Hugging Face requests. The tokenizer JSON is losslessly
minified to fit Cloudflare's per-file limit. Large files arrive in independently
verified pieces of at most 1 MiB, saved immediately in CacheStorage. Reloads and
interruptions reuse those pieces; only a piece still in flight needs restarting.
Preparation pauses when the tab is hidden or offline and resumes when it is
visible and online. Safari can suspend the page while the phone sleeps; the
download does not need to keep running during sleep. Browser
storage can still be cleared or evicted by the browser.
Tokenizer, WebAssembly and graph pieces use gzip when it saves at least 10%.
FP4 weights stay packed: sampled gzip savings were about 2% for FP4 and 7% for
the FP32 SAE, too little to justify an extra compression layer. Decompressed
files must match their original SHA-256 hashes. Previously completed model files
remain reusable without downloading them again.
Startup removes obsolete model files while retaining the current weights,
complete encoder and both execution paths. Downloads bypass the separate HTTP
cache, keeping one verified copy in CacheStorage. Storage failures stop retries
and keep completed files so a later retry can resume.
The write-in card reports incoming bytes, average transfer speed, and an estimated
time remaining that refreshes every second. Transfers
retry after 30 seconds without data; a slow file that is still receiving bytes
can continue without a fixed time limit. Only verified pieces enter the
persistent cache; inference reads fully assembled, verified files.
The catalog selects the [versioned FP4 manifest](public/model/manifest-v4-fp4.json).
Original manifest and graph URLs remain available for already-open older tabs.
Regenerate the execution checkpoints with
`uv run --with onnx python scripts/browser_steps.py` after exporting the CPU graphs.

Stored passages and percentile reference arrays retain **the original model's
full-quality scores**. Local write-ins use FP4; the score tooltip identifies
their estimated scores. The approximation can change activations and win decisions;
see the [measured FP4/FP8 comparison](docs/validation.md#quantization).

The client checks download hashes and never contacts an
inference service. All required weight chunks are downloaded **before** looking
up input tokens, so input-dependent embedding requests cannot disclose text.
Packed weights are restored to FP16 for inference, with FP32 matrix accumulation
and reductions. A separate worker reads and expands weights while inference runs,
transferring the finished buffers without copying them. Prepared weights have a
2 GB buffer budget on every device, for both GPU and CPU execution.
The queue reserves the actual output size before preparing a layer. The current
layer and runtime allocations are additional. This keeps weight conversion off the inference thread without
keeping the whole model expanded. Floating-point layer outputs stay on the GPU between execution
steps; shape outputs stay on the CPU. Per-layer embeddings and the final feature
tensor are downloaded when needed. The CPU graphs compute in FP32 and preserve the
FP16 rounding boundaries, reusing the same downloaded weights and SAE.
CPU execution uses up to four threads when the browser allows shared memory,
otherwise one. Its pinned runtime is hosted on Cloudflare; the larger GPU runtime
is loaded from a version-pinned CDN during preparation.
Custom text is scored as a complete document with a BOS token and no chat
template. Unlike a source excerpt, it has no preceding source context.
See [validation and reproduction steps](docs/validation.md) for the native and
browser scoring checks and their limits.

## Gameplay analytics

The game counters use a random first-party browser ID in local storage to
recognize returning players, plus a session ID in session storage. They count
visits, puzzle views, starts, selected public passage IDs/positions/bands,
attempt numbers, completed outcomes, practice rounds, write-in selections,
shares, model loading outcomes, and forward-pass profiles. Error categories are aggregated; bounded
exception reports are stored separately and privately. Theme usage records the selected Light/Dark/System setting
and the actual light/dark appearance, including system changes, once per
combination per visit and Pacific day. Game events carry that theme context too.
The server also stores visitor IP addresses from Cloudflare's `CF-Connecting-IP`
header alongside the browser's counters. It accepts IPv4 and IPv6, normalizing
equivalent IPv6 spellings. IPs are never accepted from the event body or
`X-Forwarded-For`. Submitted write-ins, token activations, and board snapshots
are stored privately to reconstruct games. Unsubmitted drafts are not recorded.
Browser IDs are random, rather than computed from device properties.

The backend keeps aggregate dimensions, per-browser and per-IP counters,
completed round summaries, first-visit dates, and opaque event hashes for deduplication. It also keeps an
append-only event history with browser event timestamps, session IDs and sequence
numbers, and authoritative server receipt timestamps in UTC. Round IDs
are puzzle dates or random practice IDs. Board snapshots preserve the exact
starting clue, ordered choices, guesses, text, token offsets/activations,
percentiles, model revisions, and display scale. Write-in submissions are logged
before local scoring, so a failed or cancelled submission is still visible.
Snapshot scores and device clocks are client-reported, not authoritative results.
Model failures additionally record a
server receipt timestamp (UTC), fixed error code, failed stage, CPU/GPU backend,
HTTP status or layer when known, and the browser's reported device information.
The user-agent header supplies the browser/version, OS family, and device type;
logical core count and approximate RAM are included when the browser exposes them.
The raw user agent is bounded to 512 characters. Device capabilities are collected
for forward-pass profiles and model/uncaught page errors; the reported user agent is saved with every event.
Errors also include a bounded original message, stack and cause, the failed operation,
build ID, model manifest, backend/thread/token details when available, and the last
24 gameplay/model breadcrumbs. Breadcrumbs contain actions and stages, not drafts.
URL credentials and query strings are stripped from diagnostic text. Unknown device
details stay unknown. When a rejection has no original stack, the capture location
is labeled separately. Original exceptions cannot be recovered for older reports.
Pending events are stored locally and retried after network errors and reloads
using the same IDs, so retries do not inflate counters. Blocked analytics,
cleared browser storage, or closing the browser before an event is saved can
still leave gaps; this is not a guaranteed audit log.
Browser-reported counters are approximate and may be blocked.
The private [stats page](https://interpretle.com/admin) uses HTTP Basic
authentication over HTTPS, with username `henry` and a password stored only in the
`STATS_PASSWORD` Worker secret. Set or rotate it with `npx wrangler secret put
STATS_PASSWORD`. An unset password denies all access. Reports use private,
non-cacheable responses; there is no public gameplay stats API.

The overview plots daily traffic, games, write-ins and errors; a Sankey diagram
shows games reaching each guess and then solving, exhausting attempts or remaining
unfinished. It only includes histories with a recorded opening state. Restored or
partial games are counted separately, and older aggregate activity remains in the
time-series plots. Audience/errors cover all modes; the game filter applies to
gameplay charts. The Sankey has its own Pacific date and independent Daily and
Practice switches, shared by its overview and percentile breakdown; these do not
change the dashboard's broader date window or other charts. The overview also shows attempt/option distributions, practice
frequency, themes and devices. No external chart service is used.

The flow chart places out-of-attempts games above unfinished games; unfinished
paths are ordered with later guesses above earlier guesses. Expand “Break down
each guess by percentile” for the same cohort split into 0%, 50%, 90%, 95%, 99%
and 99.9% bands. Stored selections use their recorded band. Write-ins use the
nearest band, reserving 99.9% for winning scores. Missing historical scores are
shown as Unknown rather than inferred; games without a recorded opening remain
excluded from both views.

The local model panel records every completed or failed forward pass, plus partial
traces for cancellations or crashed workers. Profiles include start time, elapsed
milliseconds, token count, CPU/GPU backend, worker run number, build and thread count.
Each layer records the individual graph operations (norms, Q/K/V projections,
attention, output and MLP projections), input preparation and waits for weights.
The weight worker reports cache-read and FP4 expansion time separately. These
background spans overlap computation; they must not be added to total latency.
GPU operation timings measure `session.run()` wall time, including dispatch and
runtime overhead, not isolated GPU kernel duration. Final readback is timed too;
profiling adds no GPU fences. Download/setup time is excluded. The dashboard shows
CPU/GPU medians and p95s, recent-pass latency, phase/operation/layer breakdowns and
individual timelines. Filter by runtime to avoid mixing CPU and GPU comparisons.
Raw profiles are in the existing private event export, linked to the write-in's
submission ID. Old passes have no retrospective profiling data.

Model downloads stay parallel, but CacheStorage writes are serialized. Transient
Safari filesystem write errors retry up to three times using the already-downloaded
bytes; quota errors stop immediately. Saved files/pieces survive a failed write.
If writing still fails, its private report includes the original exception, exact
cache operation/file, write size/attempt count and storage usage/quota when exposed
by the browser. A generic filesystem failure does not prove the disk is full.

The detailed tables and exports live at [/admin/raw](https://interpretle.com/admin/raw).
Existing `/admin?browser=...` and JSON links still work.
Select a browser to see its themes, submitted write-in frequency,
practice activity and latest 200 completed rounds across days. These detailed
histories begin with their deployment; earlier aggregate counts are preserved.
IP reports show the same metrics, associated browsers, and completed rounds,
counting only events received from that address. A browser's private history
also links to the IPs it has used. IP tracking starts with its deployment; old
events are not backfilled. These addresses and their histories are available
only in the authenticated stats page. Shared networks and changing addresses
mean an IP is not a unique person.
The overview groups repeated exceptions by operation, normalized message and stack,
error code and backend, with affected-browser counts and the latest three occurrences.
Expand an issue for its original exception, execution context, timestamps and a
link to the browser/game history. The raw page lists the latest 200 errors.
Selecting a browser or IP shows its errors
across days; otherwise the report covers the selected Pacific day. These records
start with this deployment; old aggregate events cannot be backfilled.
Recorded games includes unfinished games and links to a timestamped timeline,
full board snapshots, and an authenticated JSON download. Downloads contain
up to 100 events per page and a `nextCursor`; continue with `after=<nextCursor>`
to retrieve the remaining records. No game text or event export is public.
Detailed game recording starts with this release. A restored old game can save
its current state, but original event times cannot be recovered.
The existing daily solve histogram remains separate and excludes practice.

Production builds archive hidden source maps under the ignored
`artifacts/releases/<build-id>/` directory, and remove them from `dist` before
deployment. Preserve that directory alongside deployed builds. The deploy check
rejects public source maps. To resolve a downloaded private event export to original
source lines and code excerpts, run:

```sh
npm run errors:trace -- /path/to/interpretle-events.json
```

This uses local source maps; it does not send error reports to another service.

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

For a later daily curation pass, add `--daily-only` to the puzzle build command
to retain existing practice packs and their original provenance.

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
