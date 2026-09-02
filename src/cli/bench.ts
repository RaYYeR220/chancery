#!/usr/bin/env node
/**
 * Print the decision benchmark's scorecard.
 *
 * Needs no credentials, no network and no running server: the whole suite is
 * pure. `pnpm bench` is meant to be the fastest way for a reviewer to see what
 * the gate actually does, including the cases it is designed to refuse.
 *
 * Exits non-zero if anything regressed, so it works as a CI gate too.
 */

import { formatScorecard, runBenchmark } from "../lib/eval/runner";

const scorecard = runBenchmark();
process.stdout.write(`${formatScorecard(scorecard)}\n`);
process.exit(scorecard.passed === scorecard.total ? 0 : 1);
