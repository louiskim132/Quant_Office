# Optional CatBoost reference case — source packaging and acceptance map

Scope correction: this is an example-specific plan retained from architecture draft 0.1. It does not define the generalized team's build sequence, activate a CatBoost project, or impose its model, data, dates or policies on other projects. References below to Increment 1 and subsequent increments refer to the original CatBoost handoff only. The current platform build sequence is in `../increment-1.md`.

Architecture 0.3 further supersedes any implied agent interaction with Colab or local execution in this historical plan. All team work uses OpenAI/Anthropic-hosted infrastructure. Colab is exclusively user-operated with no agent/controller connector; only static exported code and explicitly user-imported result copies cross the boundary.

Status: scoped and source-inspected; implementation and execution are pending the approved remote environment. This file specifies checks; it is not a test result. Original M1 preregistration and `test_recatboost.py` remain missing. Do not derive new scientific authority from source comments.

## Baseline

Supplied `catboostv2.py`, 191,923 bytes, SHA-256 `9e92837a1ebd860fe5c7bdafcd878369c5c83e7527152daa86fed6375d4b1b8d`. Preserve the original and a byte-identical reference copy. The handoff itself is a different artifact with SHA-256 `0621c65b3d51b96f81db4bf27552629001bba608efbd37f8cb99f4f56cf99506`.

Source inspected through text reads/searches only. No AST parse, import, synthetic reproduction, training, or historical run verification was performed in this session. Supplied historical reproductions remain attributed to the handoff until independently rerun.

## Packaging changes, in order

1. In the approved remote workspace, verify the baseline byte hash and archive it without modification. Register source, task and environment identities before editing.
2. Extract explicit Colab setup from lines 89–118: Drive mount, pip installation, directory creation. Move random seeding and timestamp/run-directory construction into explicit run initialization. Importing core must neither mutate global RNG state nor perform project I/O. Resolve dependency versions into an environment lock, recording any behavior impact.
3. Preserve existing assembly, spread, feature, label, fold, audit and fitting functions in a minimally extracted core. Supply paths and run context explicitly where needed; do not silently change scientific constants, model parameters or algorithms.
4. Isolate the scratch spread diagnostic beginning near line 3878 into an explicitly invoked diagnostic entry point. It must never run at import or as an implicit prerequisite for the approved pipeline. Log exposure before reading a diagnostic region; later choices influenced by it require a new research version.
5. Separate setup and orchestration entry points from core imports. Add preflight and pilot wrappers that use runtime exceptions for required controls, complete structured failure artifacts, and stop before expensive production fits on failed hard gates.
6. Preserve unresolved fee/spread/family policy. Add named blockers where required facts are unavailable; changing historical behavior to enforce controls is a declared control repair, not claimed to be entirely behavior-preserving. Make the approximately 10-asset expansion a separate research branch.
7. Execute baseline-versus-packaged golden comparisons remotely for unchanged pure functions. Run independent defect fixtures and valid controls. Record A's implementation position and B's independent verification position separately, bound to exact source/test/output hashes.

## Known findings and planned acceptance

All F01–F11 remain OPEN until executed verification closes them. The locations below refer to the original baseline.

| Finding | Source anchor | Required fixture or control | Expected behavior |
| --- | --- | --- | --- |
| F01: import work | setup line 89; scratch `assemble()` line 3898; main guard line 3972 | Fresh-process import with Drive, installs, file access and diagnostic calls trapped; RNG-state check; explicit launcher control | Core import causes no setup/data/diagnostic work; explicit remote launch still works |
| F02: spread units | `CS_WITHDRAWAL_EVIDENCE` line 783 | Factor-of-ten mutant and valid fraction/bp conversions | `0.00004` is displayed as `0.4 bp`; contradiction remains open pending generator/output |
| F03: missing tick evidence | `load_asset` line 555; `derive_spreads` line 822 | Missing tick column, present all-NaN tick column, valid paired quote evidence | First two are distinct named failures under a policy requiring ticks; valid control passes |
| F04: late warm-up | `warmup_slice` line 753 | 2023 listing with first test in 2022; sufficient earlier history; forward-label horizon crossing | Derivation ends strictly before applicable evaluation with required horizon; insufficient history blocks |
| F05: family lookup | `BH_T_BY_FAMILY` line 358; `main` line 3505 | 2, 3 and 10 assets with every allowed survivor count, including 0/1 | No raw lookup crash or extrapolated fallback; unsupported policy gives `BLOCKED_POLICY` |
| F06: audit propagation | `audits_passed` line 3642 | Deliberate structural failure and detector-insufficiency cases; fit-call sentinel | Structural failure produces INVALID and zero subsequent production fits; insufficiency is INCONCLUSIVE |
| F07: invalid null | `m1_verdict` line 3448 | Empty/invalid evidence; valid negative control | Invalid evidence never becomes valid null; valid negative remains VALID_NO_EDGE |
| F08: incomplete cache | `config_fingerprint` line 2770; arm checkpoints line 2776 | Mutate each material dependency; interrupted output write; unchanged complete control | Changed or partial output cannot resume; unchanged complete verified bundle can |
| F09: provenance prose | `derive_spreads` line 822; `main` line 3505; scratch diagnostic | Conflicting coverage/source strings plus consistent structured control | Reports derive descriptions from manifest; unsupported coverage claims remain unresolved |
| F10: fee arithmetic | `FEE_PER_TXN` line 231; `round_trip_cost` line 277; `apply_cost_model` line 1972 | Independent PM-D oracle; missing exit fee mutant | Both fee sides and spread included under explicit policy; test example never freezes real fees |
| F11: diagnostic exposure | scratch diagnostic near line 3878 | A later choice linked to inspected evaluation data | Exposure persisted; dependent research version and approvals invalidated; no untouched-holdout claim |

## Additional required fixture definitions

Row accounting: inject duplicates and resampling losses; require an exact reconciliation of raw rows, rejected/duplicate rows, resampling mapping, stable-range exclusions, grid/observed/missing bars. Include a valid reconciliation.

Epoch/reset boundaries: short and long gaps, with features and labels forbidden from crossing the configured boundary. Preserve the baseline's distinctions between gap reset and stable-range truncation until an authoritative amendment changes them.

Leakage: next-bar feature leak, asset-stacked row purge versus shared wall-clock boundaries, feature/label/entry alignment and protected holdout. Deliberate violations must be detected. Test production controls under optimized Python as well as normal execution so `assert` removal cannot disable hard gates.

Independent cost examples from the supplied handoff: fee per side `0.0005` corresponds to 5 bp per side; with assumed spread `4.2481 bp`, modeled round trip is `14.2481 bp` and a three-times floor is `42.7443 bp`. These are fixture inputs/expected outputs, not verified venue economics. PM-D's oracle must not call production cost or formatting functions.

Cache mutation matrix: code, fee, spread, data bytes, chronological boundaries including holdout, features, labels, folds, test definitions, environment and launcher. Verify inventories and file hashes even when metadata claims completion.

## Evidence outputs and completion rules

The remote job exports environment lock, baseline and patched source hashes, patch, versioned test definitions, executor receipt, raw logs, structured test results, fixture hashes and limitations. A subsequent independent remote verification job records its own receipt and output hashes. Never label a self-review as an independent PM-B report.

Increment 1 is complete only when safe imports pass, seeded failure classes are exercised with valid controls, required missing inputs block explicitly, and both review positions are durable. Mock controller work (Increment 2) follows those records and uses no real provider spend. Provider connection (Increment 3), manual data preflight (Increment 4), and approved smoke/pilot (Increment 5) each require their own acceptance evidence.

No acceptance criterion in this file is currently marked PASS.
