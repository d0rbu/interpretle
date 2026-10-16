# Validation

Validated on 2026-10-16 using the pinned checkpoints and corpus revisions in
[the published provenance](../public/puzzles/provenance.json).

## Stored scores

The offline pass processed 12,504 complete documents (3,729,380 model tokens).
Every one of the 106,782 published token activations, across 2,378 passage records
and 15 targets, was checked against the extraction cache. Passage offsets,
complete source context, positive-maxima calibration arrays, and pack hashes
also matched.

On an RTX 4090, the pruned model prefix matched the full model's layer-21 output
exactly on the verification probe. Our SAE calculation matched SAE Lens across
2,048 directions and eight input texts, with maximum absolute error
`0.0000534058` and identical activation masks. Right-padded batch inference had
maximum hidden-state differences of `0.037109375` and `0.0234375` from individual
inference; the extraction uses FP16, not bit-identical arithmetic across batch
shapes.

## Browser scoring

The browser uses FP16 weights and hidden states, FP32 matrix accumulation and
reductions, and FP32 SAE parameters. Validation compares real WebGPU inference
with native PyTorch, including tokenizer IDs, UTF-16 offsets, activation values,
and activation masks. It does not mock model outputs.

All eight reference cases passed: prose, code, instructions, Unicode/whitespace,
science, dialogue, numbers, and history. The largest relative L2 activation error
was **0.1071%**, and the largest absolute error was **0.037554**. Token IDs,
UTF-16 offsets, and activation masks matched in every case. These short inputs
had 19–26 scored tokens and took 41.4–53.7 seconds each with the download cache
already populated. Scoring made no requests for model weights.

A custom sentence was also submitted through the production bundle's actual
interface for daily feature 678. Its 26 token scores had 0.1308% relative L2
error and identical activation masks. It used exactly one attempt and one
custom slot, displayed the measured 94.69th-percentile maximum, and made no
network requests during scoring. The cached-model run took 46.4 seconds.

The test machine used an AMD RDNA 2 integrated GPU, Linux Vulkan, Chromium
156.0.8078.4, and ONNX Runtime Web 1.30.0. Headless Chromium requires the Vulkan
and WebGPU flags recorded in the test script. Results are bounded to these
inputs and this hardware; they do not establish bitwise parity across GPUs.

The first complete test download used a local copy of the pinned public
checkpoint, with the same byte ranges and SHA-256 verification as production.
Separately, browser requests to Hugging Face successfully fetched and verified
three public ranges (16 MiB, 2 MiB, and 512 bytes) without credentials.

To reproduce the numerical checks after installing `requirements.txt`:

```sh
python scripts/verify_model.py
npm run dev
# In another terminal, optionally pass the pinned local model.safetensors:
node scripts/verify_browser.mjs
```

The browser harness downloads about 11.2 GB if its cache is empty and no local
checkpoint is supplied. Its results and persistent browser cache stay in ignored
`artifacts/`. The UI suite runs separately with `npm run check` and
`npm run test:e2e`; those checks do not download model weights.

## Interface and publication

All 37 unit/data checks and 14 desktop/mobile browser checks passed, including
first-visit instructions, daily/archive persistence, the eight-attempt and
two-custom limits, failed-inference refunds, and accessibility checks. Actual
measured daily puzzles were also played to completion on desktop and mobile.
Cloudflare's deployment dry run found no backend bindings.
