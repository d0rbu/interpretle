# Daily curation

The daily rotation must work as a guessing game, not just have a plausible name
for its highest-scoring examples. Review the starting clue, examples around 50,
90, 95 and 99, and multiple winning passages before admitting a feature.

- The clue's strongest highlighted token must give a useful hint about the
  pattern. Mentioning the topic elsewhere in a passage does not count.
- Prefer a clear, readable clue near the 50th percentile. The allowed window is
  45–50; show its actual measured score. Never change scores to fit a clue.
- Check more than one document and distinguish a semantic pattern from a shared
  spelling, suffix, proper name, or unrelated secondary response. Describe only
  what the examples support. Reject a feature if a fair clue is unavailable.
- Keep at least 10,000 activating reference passages and four reviewed winning
  passages from different source documents. An unrelated high score does not
  qualify as a daily winning example just because it crosses the threshold.
- Keep snippets short and coherent, and avoid navigation lists, broken excerpts,
  and needlessly distracting subject matter when a cleaner example is available.

`features.json` pins each reviewed clue by passage ID and `clueToken`, plus a
`wins` list of reviewed winning examples from distinct documents. The builder
checks the clue's strongest token and verifies that every winning example is
playable and actually scores at least 99.9. Daily targets require this review;
the builder does not silently substitute an unreviewed clue or winning example.
These checks protect the review decisions, but semantic relevance still requires
human judgment. Calibration still includes every positive passage in the original
corpus, including passages not selected for the game.

The October 2026 review replaces six daily targets, including feature 9475: its
weak examples include names and similar spellings, with no useful pain-related
clue in the allowed window. The other retired features are 196, 2549, 114, 8168,
and 130. Previously published days retain their original
packs, clues, calibration, and results. Revised daily packs use a new version;
practice keeps its separate pool.
