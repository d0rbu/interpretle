# Daily curation

The daily rotation must work as a guessing game, not just have a plausible name
for its highest-scoring examples. Review the starting clue, examples around 50,
90, 95 and 99, and multiple winning passages before admitting a feature.

For future daily puzzles, aim closer to the difficulty of the original October
20, 2026 months-in-dates puzzle (feature 959). The train-themed replacement
(feature 4302) was too easy; leave that published puzzle unchanged. The clue
and early rounds of the original were satisfactory: the correction should focus
on distinguishing the 90–99.9 percentile options, not simplifying the whole
concept. The clue should suggest a hypothesis that later highlights help refine. Prefer plausible,
related alternatives that reward learning the specific pattern over several
guesses, while keeping the winner distinguishable from the evidence. Avoid a
single obvious keyword among unrelated choices, or a final choice that depends
on hidden context.

- The clue's strongest highlighted token must give a useful hint about the
  pattern. Mentioning the topic elsewhere in a passage does not count.
- Prefer a clear, readable clue near the 50th percentile. The allowed window is
  45–55; show its actual measured score. Never change scores to fit a clue.
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

Review the endgame as a board, not just as individual passages. A near-miss that
expresses the same pattern as a winner leaves the player guessing which source
context happened to score higher. Prefer alternatives that activate related but
visibly different patterns, so the feedback helps distinguish the winner.
`choices` can pin reviewed passage IDs by band, with at least eight distinct
documents per reviewed non-winning band at 90 and above (enough for older
eight-attempt saves). Other bands retain their existing sampling requirements.

Feature 959's reviewed near-misses use full dates, weekdays, or an unspecified year; the winners
highlight month names in the month-and-year form seen in the strongest examples.
This is a playable contrast in the selected examples, not a claim that the model
always separates those formats perfectly.
`--refresh-choices` publishes that selection without changing the feature ID,
clue, calibration, or any existing passage. Old passages stay in the pack for
saved games; `choiceIds` limits only the suggestions offered in future rounds.

The October 20 daily assignment is replaced with feature 4302, a different
concept: trains and rail travel. The starting clue highlights "locomotive";
the reviewed winners highlight "train" or "trains" in descriptions of rail
journeys and services. Its near-misses include other transport, without a
competing train example. The review also removes broken fragments and navigation
lists from its suggested options. Every score, token, and calibration value is
unchanged. The old target and its saved games remain available in storage;
the replacement starts a separate game under its own feature ID.

The October 2026 review replaces six daily targets, including feature 9475: its
weak examples include names and similar spellings, with no useful pain-related
clue found in the original 45–50 window. The other retired features are 196,
2549, 114, 8168, and 130. The wider 45–55 window improves six more starting clues.
Previously published days retain their original
packs, clues, calibration, and results. Revised daily packs use a new version;
practice keeps its separate pool.

The subsequent endgame review publishes version 5 for future dates only. It
keeps each retained concept's starting clue and the original inactive and
50th-percentile pools, and pins reviewed suggestions at 90, 95, 99, and 99.9.
Scores, source context, token activations, and calibration are unchanged. For
example, emphasized comparisons can be distinguished from ordinary comparisons;
mineral descriptions from other chemical uses; and programming languages from
spoken languages or software libraries. The differences must be visible in the
passage, not just in context hidden from the player.

Twenty concepts remain in the upcoming rotation. Features 7790, 6814, 4103,
11071, 6084, 9222, 900, 41907, and 200 are held back because this review did not
establish enough readable, distinguishable alternatives across the upper bands.
Feature 4302 is also held back from future dates following the feedback that its
clue and choices make it too easy. All existing version 4 packs remain intact,
including today's train puzzle and earlier saved games. These are curation
decisions, not claims of a measured human difficulty level; playtesting can
still reveal a distinction that needs improvement.
