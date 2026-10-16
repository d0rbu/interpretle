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
Only opt-in browser write-ins use the smaller FP4 model and display `≈`.
The selected SAE encoder stays FP32: just one 2,560-value vector plus bias and
threshold per feature, with a shared input-bias vector. Quantizing it saves
little and adds error. The server performs no inference.

## Browser export and execution

The export contains decoder layers **0 through 21**, with the unused 20 layers'
columns removed from the per-layer embedding table and its projection. It
contains no later decoder weights or SAE decoder matrix. FP4 weights occupy
**2,390,408,748 bytes**; tokenizer, small graphs, positional data and runtime are
additional. The original unquantized trimmed export used 8,497,724,972 weight
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

The test download served local hashed FP4 chunks and used a local mirror of the
pinned public checkpoint for unchanged normalization ranges. The browser still
verified all hashes. Tokenizer and runtime requests use public pinned URLs.
Custom text is evaluated as a complete document with a BOS token and no chat
template or preceding source context.

To reproduce:

```sh
python scripts/verify_model.py
python scripts/compare_precision.py
python scripts/export_browser.py --fp4
python scripts/verify_model.py --fp4 --output artifacts/validation-fp4
npm run dev
# In another terminal; optionally add the pinned local model.safetensors path:
node scripts/verify_browser.mjs --reference=artifacts/validation-fp4/reference.json
```

The browser harness downloads the selected weights if its cache is empty.
Results and its persistent browser cache stay in ignored `artifacts/`.
`npm run deploy` checks every generated static model asset before uploading;
a fresh Git checkout must first run the exporter to create the ignored chunks.

## Interface and results

The unit/data and desktop/mobile browser checks cover six-attempt new games,
preservation of started eight-attempt saves, the two-custom limit, native-score
win decisions, nominal-band progression, and failure refunds. They also cover
first-visit instructions, daily/archive persistence, five suggestions plus
write-in, preloaded puzzles, the loading skeleton, intrinsic day-number width,
and stable scrollbar spacing.

Spaces and letters have identical highlight heights. Mid-animation screenshots
remain identical relative to the card when the page scrolls. Token motion animates
the actual elements relative to their card with the Web Animations API; it does
not require view transitions. Devices requesting reduced motion update immediately.
Checks also cover silent cancellation,
focus-triggered loading, queued Enter submission, the `0/280` counter, Unicode
limits, clipboard feedback and accessibility. Worker responses are mocked in
these UI tests; the numerical browser checks above run the actual model.

The daily counter uses SQLite tests for deduplication, concurrent submissions,
restart persistence, date separation, invalid requests and the X bucket for
failed games. Original win counts are preserved. Completed outcomes are
browser-reported, not a verified leaderboard. Real stored puzzles were played
through on the deployed desktop and mobile layouts without submitting test
results to public counters. Only this small counter runs server code.
