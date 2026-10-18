# Validation

Validated on 2026-10-16 against the pinned model, SAE and corpus revisions in
[the published provenance](../public/puzzles/provenance.json).

## Stored scores

The native offline pass processed **12,504 complete source documents and
3,729,380 model tokens**, scanning all **65,536 SAE features**, 19 residual
coordinates and 128 gated MLP coordinates. Documents longer than 1,024 tokens
were skipped, not truncated. The passage population contains 86,194 excerpts;
calibration uses every positive maximum for the selected feature, including
excerpts not selected for a game card.

The active library has 30 curated daily concepts and a separate practice pool:
48 experimental SAE features (12 from each quarter of the dictionary), eight
MLP neurons and one residual coordinate. Previously published daily packs keep
their original measurements and provenance. Daily and practice SAE indices are
disjoint. Every new pack has at least 10,000 positive reference passages,
at least four winning examples from different documents, and a starting clue
between the 49.9th and 50th percentiles.

All **580,694 published token values in 13,386 passage records across 88 active
packs**, along with tokenizer IDs, UTF-16 offsets, preceding context, calibration
arrays and pack hashes, were checked against the original extraction cache. The context contains at most 64 preceding tokens; only the passage's own
stored token scores contribute to its displayed maximum. New excerpts have at
most 80 tokens and three approximate sentence boundaries. No quantized model is
used to produce or recalibrate stored scores.

On an RTX 4090, the original pruned prefix matched the full model's layer-21
residual output and gated MLP output exactly on the verification probe. Our SAE
calculation matched SAE Lens across all 65,536 features and eight texts, with
maximum absolute error **0** and identical activation masks. Native extraction
uses the BF16 checkpoint converted to FP16, with FP32 SAE parameters. Right-padded
batch inference differed from individual inference by at most `0.037109375` and
`0.0234375` on the two padding probes; arithmetic is not bit-identical across
batch shapes.

## Quantization

The [full comparison report](precision.json) covers **418 complete source
inputs, 152,545 scored tokens, all 65,536 SAE features and 128 MLP coordinates**.
Inputs include eight reference texts, 30 documents per corpus source, and the
complete source documents behind all published winning examples from the first
14 daily features. Percentile and win comparisons use those 14 features' original
calibration arrays: **48,720 passage-feature comparisons, including 345 native
winning comparisons**. This deliberately samples winning cases; it is not an
estimate of the frequency of wins in arbitrary player text.

Both formats use blocks of 32 weights, FP16 scales, and FP16 restored model
weights. FP8 is E4M3; FP4 is E2M1. Model trials keep the SAE encoder in FP32.
Encoder-only trials keep the original model outputs and FP32 encoder compute.
Biases, thresholds and normalization vectors are unchanged.

| Quantized component | SAE relative L2 error | Active percentile error: median / 95th | False wins | Missed native wins |
| ------------------- | --------------------: | -------------------------------------: | ---------: | -----------------: |
| Model FP8           |                17.09% |                    1.86 / 12.54 points |          9 |           46 / 345 |
| Model FP4           |                49.25% |                   10.50 / 46.92 points |         17 |          255 / 345 |
| Encoder FP8         |                 4.85% |                     0.55 / 3.38 points |          4 |            6 / 345 |
| Encoder FP4         |                22.68% |                    7.70 / 32.57 points |         17 |          113 / 345 |

“Active” includes comparisons where either model activates. Counting all the
inactive comparisons gives FP4 a misleadingly small median percentile error.
Likewise, its **272 changed win decisions** are only 0.56% of all comparisons,
but include **255 of the 345 native wins**. FP4 is an approximation and does not
preserve the original activation scores near the winning boundary.

The chosen product contract keeps native stored scores and reference arrays.
Only browser write-ins use the smaller FP4 model and display `≈`.
The SAE encoder stays FP32, with a shared input-bias vector. The original
per-feature export used one 2,560-value vector; the v3 export caches the complete
dictionary, as described below. The server performs no inference.

## Browser export and execution

The export contains decoder layers **0 through 21**, with the unused 20 layers'
columns removed from the per-layer embedding table and its projection. It
contains no later decoder weights or SAE decoder matrix. The v2 FP4 model weights
occupied **2,390,408,748 bytes**, before adding the full encoder in v3;
tokenizer, small graphs, positional data and runtime are additional.
The original unquantized trimmed export used 8,497,724,972 weight
bytes, down from the first 11,208,293,932-byte browser selection.

Every exported chunk's SHA-256 hash, byte count and tensor coverage was audited.
All **4,248,567,808 quantized matrix weights** were packed and decoded with
bit-identical FP16 results to the native quantizer. Normalization vectors retain
their original bytes. Static chunks are at most 16 MiB. Browser unit tests also
check real packed checkpoint blocks against PyTorch and exercise subnormal,
rounding and signed-zero conversion.

Real WebGPU inference passed **16 reference cases**: eight SAE and eight gated
MLP targets spanning prose, code, instructions, Unicode/whitespace, science,
dialogue, numbers and history. These comparisons use the **same FP4 approximation
in PyTorch**; quantization error versus the original model is reported separately
above. Maximum relative L2 error was **0.4576%**, maximum absolute error was
**0.161706**, and every tokenizer ID, UTF-16 offset and activation mask matched.
No weights were requested during scoring after preparation. The 19–26-token
cases took 11.3–19.9 seconds each with weights cached.

A real custom sentence also passed through the compiled application's write-in
card for daily feature 678. Its 26 token scores had 0.2266% relative L2 error
against native FP4, with identical activation masks. Queued Enter used exactly
one attempt and one custom slot, and the `≈` marker survived a reload. Loading
and inference took 26.6 seconds with weight chunks already cached; no weights or
custom text were sent over the network during this check.

The test machine used an AMD RDNA 2 integrated GPU, Linux Vulkan, Chromium
156.0.8078.4 and ONNX Runtime Web 1.30.0. The flags are recorded in the browser
harness. These results are specific to the tested inputs and hardware, not a
claim of bitwise parity across GPUs. The browser always evaluates one unpadded
input. FP4 padding probes differed by `0.099365234375` and `0.05859375`; FP4 was
not qualified for batched offline extraction.

The original numerical test served local hashed FP4 chunks and used a local
mirror of the pinned public checkpoint for unchanged normalization ranges.
V3 hosts those ranges and the tokenizer on Cloudflare; the GPU runtime uses
a public pinned CDN URL. The browser verifies model and tokenizer hashes.
Custom text is evaluated as a complete document with a BOS token and no chat
template or preceding source context.

To reproduce:

```sh
python scripts/verify_model.py
python scripts/compare_precision.py
python scripts/export_browser.py --fp4
python scripts/verify_model.py --fp4 --output artifacts/validation-fp4
npm run dev
# In another terminal:
node scripts/verify_browser.mjs --reference=artifacts/validation-fp4/reference.json
```

The browser harness downloads the selected weights if its cache is empty.
Results and its persistent browser cache stay in ignored `artifacts/`.
`npm run deploy` checks every generated static model asset before uploading;
a fresh Git checkout must first run the exporter to create the ignored chunks.

## Browser CPU fallback

On 2026-10-17, real Firefox CPU inference passed two SAE cases, including the
Unicode/whitespace input, and one gated MLP case against the native FP4 reference.
All tokenizer IDs, UTF-16 offsets and activation masks matched. Maximum relative
L2 error was **0.0828%**, with maximum absolute error **0.035788**. The compiled
production worker was checked for the SAE cases; the MLP case also passed through
the development browser harness. These measure runtime agreement with FP4,
separately from FP4's error against the original model above.

Chromium also completed a real CPU case after an intentionally failed GPU runtime
download: 0.0559% relative L2 error and identical activation masks. A WebGPU
regression case passed with 0.0311% relative L2 error. No case requested
input-dependent weights after model preparation.

The CPU graphs perform FP32 arithmetic with explicit casts preserving the
original FP16 rounding boundaries; model weights, SAE parameters and stored
scores are unchanged. The CPU runtime is hosted on Cloudflare. Cross-origin
isolation enables up to four CPU threads, with a single-thread fallback.
Short 19–22-token inputs took 80.8–189.3 seconds on an AMD Ryzen 9 9950X
running Linux under concurrent host load. These are not macOS measurements.
The compiled worker also passed the Unicode case on the live domain in Firefox,
using Cloudflare's actual isolation headers and CPU runtime: 108.4 seconds,
0.0559% relative L2 error, and no weight requests during scoring.

CPU weight restoration now uses a shared 65,536-entry FP16-to-FP32 lookup table.
An exhaustive conversion check preserves every finite FP16 value, signed zero,
infinities and NaNs. For a measured 26,214,400-value MLP matrix, median conversion
time fell from 2.021 seconds to 0.047 seconds in Node 24 on Linux. This measures
only conversion, not whole-model speed. The updated production worker completed
the 22-token Unicode SAE case in Firefox CPU mode in 16.994 seconds, with token
IDs, offsets and activations identical to the earlier worker and no scoring-time
weight requests. The earlier timings above predate this optimization; neither
run is a MacBook measurement or a controlled whole-model speed comparison.

For quick SAE and MLP checks using the FP4 reference and a local development server:

```sh
python scripts/browser_cpu.py
node scripts/verify_browser.mjs --firefox --case=3 --reference=artifacts/validation-fp4/reference.json
node scripts/verify_browser.mjs --firefox --case=8 --reference=artifacts/validation-fp4/reference.json
# Chromium without WebGPU:
node scripts/verify_browser.mjs --cpu --case=3 --reference=artifacts/validation-fp4/reference.json
```

The cache tests cover repairing a corrupted cached tokenizer before reuse.
Tokenizer download, JSON parsing, initialization and runtime failures now have
separate error stages. The reported macOS tokenizer failure was not reproduced
on the Linux Firefox test machine.

The within-layer progress update partitions each existing layer graph into 15
execution steps without changing its nodes or weights. In the compiled worker,
the Unicode SAE case on Firefox retained exactly the same token IDs, offsets and
activations as the previous whole-layer implementation. The two Unicode SAE/MLP
checks on Chromium WebGPU had 0.0310% / 0.3383% relative L2 error against native
FP4, with identical activation masks and no weight requests during scoring.

An additional Unicode MLP stress case (neuron 6907) exposed an existing CPU
limitation: the previous whole-layer graph has **1.2314%** relative L2 error and
0.042969 maximum absolute error against native FP4, with no activation-mask
differences. This case exceeds the harness's 1% native-parity threshold. It does
not affect the stored full-quality puzzle scores. A paired compiled-worker check
confirmed that the new checkpointed CPU output is bit-for-bit identical to the
previous whole-layer output on this case as well; all 15 progress stages were
reported, with no scoring-time weight requests.

WebGPU now keeps floating-point outputs on the GPU between execution steps;
integer shape outputs remain on the CPU. The graphs, weights and precision are
unchanged. A paired compiled-worker check on an NVIDIA RTX 4090 with Chromium
and Linux Vulkan preserved every token ID, offset and activation exactly across
three SAE/MLP cases, including Unicode text. No weights were downloaded during
scoring. The median scoring time was 10.846 seconds before and 9.012 seconds after
the change (about 17% faster). This was a shared, busy GPU, not a controlled
hardware benchmark or a MacBook measurement.
The Firefox CPU regression case also retained exactly the same token IDs,
offsets and activations as the previous compiled worker (0.0559% relative L2
error against native FP4).

On that GPU, the same Unicode MLP stress case had **1.0903%** relative L2 error
against native FP4 both before and after the change, exceeding the 1% native
threshold. Its activation mask still matched, and the optimization preserved its
existing output exactly; this does not establish native parity for that case.

Weight preparation now runs in a separate worker: cached chunks are read together,
FP4 values are restored using shared byte-pair lookup tables, and completed arrays
are transferred to the inference worker. The preparation queue reserves its output
bytes before scheduling work, with a hard limit of 2,000,000,000 bytes on every
device, for both GPU and CPU execution. That fits ten prepared GPU layers or five
CPU layers. Reads and conversion overlap with inference; no server scoring or
new model format is involved.

Sizes calculated from the pinned manifest (decimal GB, weights only):

| Prepared weights                                        | FP16 GPU | FP32 CPU |
| ------------------------------------------------------- | -------: | -------: |
| Largest single layer                                    |    0.212 |    0.425 |
| Largest ten-layer window                                |    1.914 |    3.828 |
| Largest eleven-layer window                             |    2.100 |    4.200 |
| All 22 transformer layers                               |    4.174 |    8.348 |
| Full trimmed model, including complete embedding tables |    8.498 |   16.995 |

The 2 GB limit covers prepared future layers. The current layer, temporary packed
reads, runtime allocations, activations and GPU buffers are additional. The complete
SAE encoder adds 0.672 GB in browser storage; scoring reads only its selected row.

With this queue, the same three-case Chromium/RTX 4090 comparison preserved
every token ID, offset and activation exactly, including the existing Unicode
MLP limitation above. No weights were fetched during scoring. Median scoring
time fell from 10.741 to 5.762 seconds; time waiting for weights fell from 5.955
to 0.332 seconds. The largest observed prepared queue was 1,887,704,084 bytes.
These are shared-machine measurements, not MacBook results. An exhaustive check
of all 65,536 FP16 scale encodings and all 256 packed bytes also preserved the
previous converter's output bits and rejected scales exactly. The Firefox CPU
regression case retained every token ID, offset and activation exactly, with no
scoring-time weight requests.

## Interface and results

The unit/data and desktop/mobile browser checks cover six-attempt new games,
preservation of started eight-attempt saves, the two-custom limit, native-score
win decisions, nominal-band progression, and failure refunds. They also cover
first-visit instructions, Pacific-midnight rollover (including daylight saving),
daily/archive persistence, five suggestions plus
write-in, preloaded puzzles, the loading skeleton, intrinsic day-number width,
and stable scrollbar spacing.
Malformed source text is excluded from new choices without rewriting measured
input or changing the reference distribution. Two affected practice clues use
clean replacements near the median from the existing native extraction cache;
their pack provenance hashes are updated.

Spaces and letters have identical highlight heights. Space highlights animate
in both directions while keeping native inline wrapping. Mid-animation screenshots
remain identical relative to the card when the page scrolls. Token motion animates
the actual elements relative to their card with the Web Animations API; it does
not require view transitions. Collapsing context keeps tokens on one line while
they return to normal weight, without a jump at the start of the animation.
Devices requesting reduced motion update immediately.
Write-ins reuse the same token rendering with a loading wave over actual tokenizer
offsets. Intermediate token messages carry no activations and cannot complete or
charge an attempt. The overlay preserves the draft, focus, scroll position and
card height; completion, cancellation and errors remove it. Reduced motion uses a
static tint. Preview tokens and text are never included in analytics.
Checks also cover background model preparation without blocking stored passages,
joining the same download on focus, silent cancellation and retries,
queued Enter submission, the `0/280` counter, Unicode
limits, clipboard feedback and accessibility. Worker responses are mocked in
these UI tests; the numerical browser checks above run the actual model.

The daily counter uses SQLite tests for deduplication, concurrent submissions,
restart persistence, date separation, invalid requests and the X bucket for
failed games. Original win counts are preserved. Completed outcomes are
browser-reported, not a verified leaderboard. Real stored puzzles were played
through on the deployed desktop and mobile layouts without submitting test
results to public counters. The server also collects first-party game counters;
neither backend runs inference or receives custom text.

## Complete browser encoder and hosted assets

The v3 export transposes all **167,772,160 FP32 encoder values** into contiguous
feature rows in static chunks. Every value was checked for exact equality with
the pinned SAE checkpoint, including all biases/thresholds and the shared input
bias. The 79 published SAE encoder vectors also match exactly. All 272 existing
FP4 model matrix chunks and model tensor descriptors are unchanged.

The tokenizer is losslessly minified from 32,170,070 to 13,593,553 bytes. Its
parsed JSON is identical. Tokenizer configuration and the remaining 177 model
parameter chunks are hosted on Cloudflare alongside the model and full encoder.
All 566 asset references, including the CPU graphs and runtime, have verified
hashes and fit the 25 MiB per-file limit.
Duplicate weight chunks are downloaded once. Weights total 3,062,013,994 bytes;
including the tokenizer, checkpoint graphs and positions the GPU download is
**3,077,354,105 bytes** before its runtime. The CPU download including its runtime
is **3,091,638,749 bytes**.
The SAE decoder and layers after 21 are not included.

The cache tests cover network retries, integrity failures, permanent HTTP errors,
storage exhaustion, reuse after a completed download, and reading feature 65,535
without a network request. Analytics SQLite tests cover duplicate events after
restart, Pacific-day boundaries, returning browsers, practice counts, option
dimensions, and rejecting custom text or raw errors.
