# Data sources and licenses

The game publishes excerpts and up to 64 preceding model tokens from these public datasets.
Each stored passage record includes its source and license. Text is split into
displayed spans and annotated with measured activations; it is not rewritten.
Dataset revisions are pinned in `scripts/prepare_corpus.py` and recorded in the
published provenance. Corpus selection keeps complete documents that fit the
1,024-token context window. This is a selected corpus, not every row in the
upstream datasets.

| Source and attribution                                                                                                | License                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [OpenAssistant contributors, OASST1](https://huggingface.co/datasets/OpenAssistant/oasst1)                            | [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0)                                                                                            |
| [Ronen Eldan and Yuanzhi Li, TinyStories](https://huggingface.co/datasets/roneneldan/TinyStories)                     | [Community Data License Agreement – Sharing 1.0](https://cdla.dev/sharing-1-0/)                                                                      |
| [Google Research, Mostly Basic Python Problems](https://huggingface.co/datasets/google-research-datasets/mbpp)        | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)                                                                                            |
| [Wikipedia contributors, English Wikipedia, 2023-11-01 snapshot](https://huggingface.co/datasets/wikimedia/wikipedia) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/); individual article links identify the contributors through their revision histories |

Redistributed TinyStories text remains under CDLA-Sharing-1.0. Redistributed
Wikipedia text remains under CC-BY-SA-3.0. These share-alike terms apply to the
respective text, independently of the MIT license for application code.

The base model is [Google Gemma 4 E4B](https://huggingface.co/google/gemma-4-E4B),
revision `411aa17b749aa952df1359d2dcea73917a544d9a`. The SAE is
[Decode Research's Gemma 4 SAE](https://huggingface.co/decoderesearch/gemma-4-saes),
revision `bb8e6b333def5cf2667f2cd4b9e67258dae7029b`, directory
`gemma-4-e4b/btk-mat-layer-21-k-100`. Gemma is Apache-2.0 licensed. The pinned
SAE release does not declare a license; it is attributed to David Chanin and
Johnny Lin at Decode Research and is not covered by this application's MIT
license. The small exported graphs and per-feature encoder vectors derive from
these checkpoints.

Inference uses FP16 model weights/hidden states and FP32 SAE parameters. Despite
the training directory's BatchTopK name, its released inference architecture is
JumpReLU: `relu((h - b_dec) @ W_enc + b_enc)`, gated by the learned threshold.
We use the encoder direction, not the decoder direction. BOS, padding, and
special tokens never contribute to passage maxima. Browser offsets use UTF-16;
overlapping offsets from byte-fallback tokens share a displayed highlight while
retaining their individual activation values in the stored data. Context is
trimmed only for display; extraction still uses each complete source document.

Feature discovery uses the first 2,048 directions of the 65,536-direction
Matryoshka SAE. Published targets have at least 10,000 positive reference
passages. Feature names describe recurring patterns in reviewed examples;
they are interpretations, not definitive descriptions of what a feature means.
Experimental coordinate targets use the positive part of a layer-21 residual
coordinate, `max(0, hidden[index])`; they are not MLP neurons.
