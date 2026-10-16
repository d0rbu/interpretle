# Game design

## Decisions from the first design session

Confirmed on October 16, 2026:

1. Daily puzzle **and** practice mode.
2. Eight attempts, with at most two custom sentences. Both custom and suggested plays use an attempt.
3. A starter passage with maximum activation at the **50th percentile**, with per-token background highlighting. Every played passage reveals the same information plus its maximum score.
4. Percentiles are computed among **activating passages**, with inactive passages shown as zero.
5. A broad passage mix: chat, prose, code, and technical text.
6. Curated SAE features for daily play; experimental features and individual neurons can appear in practice.
7. Static hosting only: all corpus activations are computed offline, and custom text runs locally through WebGPU. Keep the backend readable in 5–10 minutes; avoid adding services.
8. Offline extraction runs with **full source context**. Only the displayed passage receives visible token scores, and its maximum is computed over that displayed span. Surrounding context remains readable without exposing its scores.

The feature's human-readable interpretation is revealed at the end in this prototype. This is a provisional design choice, rather than an additional confirmed requirement.

## Round flow

The starter is a **free clue**. The player's own best score starts at zero, so the opening sampling schedule still applies. This interpretation was stated during the design session and can be changed independently of the rest of the game.

Choose a card, optionally expand its context, then press **Test passage**. Only the test consumes an attempt. All scores and highlights on unplayed cards are hidden in the UI. The tested text appears in the field notes with its highlights, maximum, and token inspection. New options are sampled using the highest score so far, so an inactive guess does not make the game harder again.

The maximum is a percentile rank, not a fraction of a neuron's theoretical maximum. The main game presents passage maxima as percentile scores. Production token inspection should expose raw activation as well as percentile and preserve actual tokenizer boundaries.

## Adaptive sampling

Each row is a multiset; shuffle presentation order so position does not reveal score.

| Player best              | Eight target bands                    |
| ------------------------ | ------------------------------------- |
| 0 / inactive             | 0, 0, 0, 0, 50, 90, 95, 99            |
| Greater than 0, below 50 | 0, 0, 0, 50, 90, 95, 99, 99.9         |
| 50 to below 90           | 0, 0, 50, 90, 95, 99, 99.9, 99.9      |
| 90 to below 95           | 0, 50, 90, 95, 99, 99.9, 99.9, 99.9   |
| 95 to below 99           | 0, 90, 95, 99, 99, 99.9, 99.9, 99.9   |
| 99 to below 99.9         | 0, 95, 99, 99, 99.9, 99.9, 99.9, 99.9 |

The first four rows follow the user's proposed distribution. The final two are an initial extrapolation to playtest. Boundaries are lower-inclusive. The 99.9 band always contains genuine winning passages in a measured puzzle; a near miss must not be relabeled as 99.9.

The demo prioritizes cards not shown in earlier rounds. It never repeats an already played card or duplicates a card within a round. Its small pool can reoffer an unplayed card when a band has no unseen cards left. Production needs larger pools and an explicit exhaustion policy.

## Daily fairness and practice

The current date seed, versioned demo corpus, and prior actions produce deterministic decks. Players taking the same path see the same cards. Different prior scores naturally lead to different decks. A daily puzzle remains open until midnight UTC; an open tab switches to the next puzzle when it notices the date change. Progress is browser-local, and each UTC date gets its own save. Keep this in the client.

Practice keeps a separate save and can be reset. The three demo themes can repeat. Freeze the measured daily schedule and publish static puzzle files. This is an honor-system game: technically inclined players can inspect downloaded scores and reset browser-local limits. Accept that tradeoff instead of building an anti-cheat backend. Practice can provide a target-type selector once measured neuron and SAE catalogs exist.

## Open choices for the next iteration

- **Length:** The prototype limits custom input to 280 Unicode code points. A real model service should also enforce a token cap. Fixed-length or length-stratified references may reduce the advantage of longer passages under max pooling.
- **Corpus balance:** Choose source datasets, license-compatible excerpts, proportions, language policy, and visible attribution. The mix must be the same for calibration and candidate sampling.
- **Feature curation:** Prefer understandable features with plentiful inactive and strong examples, varied language, and no single memorized document doing all the work. Keep ambiguous, structural, and neuron puzzles available for experimental practice.
- **Reveal:** A conservative human description, representative token examples, and an optional source link. A feature label is an interpretation, not a ground-truth definition.
- **Difficulty:** Measure solve rate, round count, and behavior of the top bands before changing the schedule. The 50th-percentile starter may already reveal a simple feature, while a heterogeneous feature may stay confusing even at high scores.

No production dataset, feature selection, score table, or GPU campaign has been generated yet.
