# Synthetic office task: feature-availability review

This is a software/retrieval fixture. All records and experiments are invented.
No prices, chart data, network access, training, performance evaluation, or backtest is needed.

## Track A — code and evidence (use this exact prompt for every configuration)

Fix `src/eligibility.mjs` so `classify(row)` implements the current contract in
`docs/contract-v2.md`. Preserve its export and return shape. Inspect the caller
and relevant documents before changing code. Use built-in Node APIs; add no
dependencies. You may edit `src/` and add tests. Do not change the supplied inputs
or documents. Add `REPORT.md`, no more than 600 words, answering:

1. Which contract governs and why is the older contract insufficient?
2. Which of the Amber and Birch experiments must have their inputs rechecked,
   and what documents establish that connection?
3. What does the failed run imply, and can either experiment be called profitable?
4. What did you change, what checks did you actually run, and what is still unknown?

Cite document filenames and section headings. Keep counterevidence and uncertainty.
Conciseness must not remove required checks or alter the contract. Do not execute
an experiment. Output the changed files, checks, and report.

## Track B — document retrieval (separate fresh session)

Use only the supplied documents to answer questions 1–3 above in `REPORT.md`
(at most 450 words). Cite filenames and headings; distinguish recorded facts
from implications. No code changes or execution are required. This is the same
document task for baseline, Graphify, and LightRAG; code-only tools are not ranked
on this track. You may request original source sections whenever needed.

## Local example command

From this task directory: `node src/preview.mjs`. This prints classifications of
eight synthetic metadata records. It performs no financial calculation.
