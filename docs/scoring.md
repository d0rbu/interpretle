# From a playable prototype to measured activations

The browser game is running on fixtures. **None of its scores, highlights, or theme names are measurements or interpretations of a Gemma feature.** The calibration function is tested on numerical fixtures; it has not been qualified against GPU inference.

## Verified checkpoint identity

Metadata was checked on October 16, 2026. [Machine-readable target](../data/model-target.json):

| Field                           | Value                                      |
| ------------------------------- | ------------------------------------------ |
| Base model                      | `google/gemma-4-E4B`                       |
| Observed model revision         | `411aa17b749aa952df1359d2dcea73917a544d9a` |
| SAE repository                  | `decoderesearch/gemma-4-saes`              |
| Observed SAE revision           | `bb8e6b333def5cf2667f2cd4b9e67258dae7029b` |
| SAE directory                   | `gemma-4-e4b/btk-mat-layer-21-k-100`       |
| Hook                            | `model.language_model.layers.21`           |
| Input width / number of latents | 2,560 / 65,536                             |
| Saved inference architecture    | JumpReLU                                   |
| Training architecture           | Matryoshka BatchTopK, k = 100              |

The [release card](https://huggingface.co/decoderesearch/gemma-4-saes), [pinned inference config](https://huggingface.co/decoderesearch/gemma-4-saes/blob/bb8e6b333def5cf2667f2cd4b9e67258dae7029b/gemma-4-e4b/btk-mat-layer-21-k-100/cfg.json), and [pinned training config](https://huggingface.co/decoderesearch/gemma-4-saes/blob/bb8e6b333def5cf2667f2cd4b9e67258dae7029b/gemma-4-e4b/btk-mat-layer-21-k-100/runner_cfg.json) are the sources. The training config uses a 1,024-token context, prepended BOS, no chat formatting, and excludes special tokens. The saved SAE subtracts decoder bias from its input and uses no activation normalization.

The inference config matters: do not implement a fresh batch-dependent top-k rule just because the directory includes `btk`. Load the saved encoder and thresholds, and verify results against the supported SAELens implementation. A dot product against a decoder direction is a different scorer. Layer numbering must follow the literal module path, with a hook parity test, rather than guessing from a hidden-state tuple index.

These revision IDs identify the artifacts inspected now. They do not establish that this exact base-model revision was the one used by the SAE authors during training. Confirm weight/tokenizer compatibility before treating it as qualified provenance.

## Passage and token score

Run the offline extraction over the **full source context**, then retain the token/character alignment of each displayed passage within that forward pass. For feature `f`, obtain the actual SAE encoding `z[t, f]` at each eligible token in the **displayed span**. The raw passage score is:

```text
raw_max(passage, f) = max(z[t, f] for eligible t in the scored passage)
```

Only display scores and highlights for that span; do not show scores for surrounding context or include its tokens in the passage maximum. Expanding the context reveals source text, not additional heatmaps. Do not re-score the excerpt in isolation after extraction.

Exclude padding, BOS, and other special tokens from the maximum. Respect the attention mask and use the same model precision, tokenizer, BOS handling, hook, and SAE encoder for the corpus and custom guesses. A forward pass is enough; no text generation is required.

Freeze a representative reference corpus. Let `R` contain its **strictly positive passage maxima**, sorted in ascending order. The proposed empirical convention, implemented in `src/lib/scoring.ts`, is:

```text
percentile(a) = 0                            if a == 0
percentile(a) = 100 * count(r < a) / len(R)  otherwise
win          = percentile(raw_max) >= 99.9
```

Strict lower ranks prevent a large tied value from being promoted to a win just because it includes itself. Do not round before the win check. Scores can exceed all reference values and receive 100. Freeze the reference hash with the puzzle; never recalibrate against a player's options or custom submissions.

**Inactive and percentile-zero are different fields.** A very small positive out-of-sample activation, or a tied reference minimum, can have a strict rank of zero. A measured result must carry `active = raw_max > 0` separately. The UI should show such a result as active but below the first resolvable percentile, not label it inactive. The demo's score-zero fixtures are all genuinely inactive within its toy scoring rule.

For each token, preserve its raw activation, actual token ID, and exact text offsets. Color strength should use a fixed feature-specific scale (for example raw activation relative to the fixed 99.9th-percentile reference threshold, clamped for color only). Do not renormalize every passage to its own maximum: that would make a weak 50th-percentile passage appear as strong as a winning passage. Token tooltips can show both raw activation and its rank against the same passage-maximum reference; explain this denominator rather than implying a separate token-population percentile.

The current demo approximates tokens using whitespace-separated words and uses a simple illustrative color scale. Its synthetic raw values are arbitrary units. The production integration must replace both the word segmentation and toy scoring.

## Corpus and feature qualification

The requested mix includes chat, prose, code, and technical text. Start with a fixed, versioned corpus manifest containing dataset IDs/revisions, license and attribution, document IDs, text hashes, extraction offsets, and the exact scored span. Do not infer redistribution permission from a dataset name. Keep held-out calibration documents separate from the candidate passages, and preserve source proportions across both.

A useful starting admission target is **at least 10,000 positive calibration passages per feature** and sufficient independent top-tail candidates. This is a proposed practical floor, not a statistical guarantee. The required total corpus size depends on how often the feature activates. Report the actual positive count, inactive rate, duplicate rate, per-source coverage, and tie structure.

Precompute raw token activations and passage maxima for shortlisted features. Store percentiles as derived data tied to the reference hash. Curate daily features for interpretability, enough distinct examples in every band, and manageable excerpt lengths. Neuron experiments need a separately identified activation site, pre/post-nonlinearity convention, sign/direction, and calibration; do not reuse an SAE reference.

The real sampler should use documented percentile intervals around the requested bands, preserve actual measured scores, and fail qualification if a required band is empty. The winning interval must be `[99.9, 100]`. The free clue needs a measured score near 50 with its exact maximum shown; do not relabel it as exactly 50 if that is not what was measured.

Longer displayed passages have more chances to contain a strong token. Decide a consistent length policy or calibrate by length before making difficulty claims. The confirmed extraction contract is full source context with displayed-span-only scores. Record the exact input window, document boundaries, formatting, and scored token offsets in the corpus manifest. If a source exceeds the model context limit, choose and document a windowing policy rather than silently treating an isolated excerpt as full context. Calibration must use maxima extracted under the same context policy.

For custom input, the browser can accept optional user-provided context separately from the passage to score. Context conditions the forward pass but is excluded from the displayed maximum. An absent context is explicitly empty. Report this distinction when comparing a standalone custom input with a contextual source passage.

## Static delivery and local custom scoring

The server serves static files only. The full architecture fits in [one short document](architecture.md). Offline corpus preprocessing supplies the stored activations; the player's browser samples the game and runs custom text locally through WebGPU. There is no scoring API, GPU server, game-session service, or remote fallback.

An exported browser scorer must expose the exact layer-21 activation rather than just generated tokens or final embeddings. It can omit later layers and the language-model output head if export parity is verified. Persist the scorer hash and quantization with every calibration and puzzle artifact. A single-feature SAE export may only need its encoder column, input bias, latent bias, and threshold, subject to parity against the released encoder. Neuron targets need their own explicit hook/coordinate/sign convention.

Local failures do not consume attempts. Loading browser weights is opt-in and should show download size/progress. Cache assets and perform inference in a client Web Worker. Stored-passage play must remain available when WebGPU is unavailable. Accept browser-local quota enforcement and inspectable answer data rather than adding anti-cheat infrastructure.

## Browser runtime investigation

The [Transformers.js WebGPU guide](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/guides/webgpu.md) supports local browser inference. The [published Gemma 4 ONNX collection](https://huggingface.co/collections/onnx-community/gemma-4-onnx) includes **instruction-tuned** E4B exports. The SAE metadata instead names the **base** `google/gemma-4-E4B` checkpoint. The [WebLLM October 11 release](https://github.com/mlc-ai/web-llm/releases/tag/v0.2.86) advertises E2B instruction-tuned support.

Those findings establish plausible runtimes, not qualification of this game's exact model/hook. Do not silently swap in E4B-it, E2B, final embeddings, or a text-generation endpoint. A matching base-model activation export and parity check remain necessary. No browser model has been downloaded or benchmarked in this prototype.

## Next executable milestone

Implement and run a bounded offline pilot after the corpus sources and extraction windows are settled. Verify hook parity, token/offset reconstruction including Unicode, padding invariance, batch invariance, exact zero handling, and parity between stored scores and the exported local scorer on identical text. Then run the agreed dataset through the scorer, retain token activations for SAE and neuron targets, and build a small qualified feature set into static packs. No model weights have been downloaded, GPU resources rented, or inference throughput measured in this initial prototype work.
