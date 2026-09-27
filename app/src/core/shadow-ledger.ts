import {
  shadowBatchSchema,
  evaluateShadow,
  type ShadowPrediction,
  type Quote,
  type Fill,
  type ShadowPolicy,
} from '../shared/shadow';
import { canonical } from './canonical';

/** Replay admitted batches in append order. Imported timestamps never replace admission time. */
export function replayShadow(batches: { body: unknown; receivedAt: string }[], policy: ShadowPolicy, now: string) {
  const predictions = new Map<string, ShadowPrediction>(),
    quotes = new Map<string, Quote>(),
    fills: Fill[] = [],
    outcomes: Record<string, number | null> = {};
  const actual: Fill[] = [];
  const fillIdentities = new Map<string, string>();
  for (const { body, receivedAt } of batches) {
    const batch = shadowBatchSchema.parse(body);
    if (batch.kind === 'PREDICTIONS')
      for (const raw of batch.predictions) {
        if (raw.branchId !== batch.branchId || raw.specId !== batch.specId || raw.candidateHash !== batch.candidateHash)
          throw new Error('Prediction scope differs from its admitted batch.');
        if (Date.parse(raw.forecastFor) <= Date.parse(receivedAt))
          throw new Error('Predictions must enter durable custody before their forecast time.');
        const prediction = { ...raw, recordedAt: receivedAt };
        const previous = predictions.get(raw.id);
        if (previous && canonical(previous) !== canonical(prediction))
          throw new Error('A prediction identity cannot be revised after ingestion.');
        predictions.set(raw.id, prediction);
      }
    else {
      for (const fill of batch.fills) {
        const key = canonical([fill.predictionId, fill.at, fill.kind, fill.provenance, fill.quantity]),
          value = canonical(fill),
          prior = fillIdentities.get(key);
        if (prior) {
          if (prior !== value)
            throw new Error('Conflicting fill observations cannot replace admitted execution evidence.');
          continue;
        }
        fillIdentities.set(key, value);
        const prediction = predictions.get(fill.predictionId);
        if (
          !prediction ||
          prediction.symbol !== fill.symbol ||
          Date.parse(fill.at) < Date.parse(prediction.recordedAt) ||
          Date.parse(fill.at) > Date.parse(receivedAt)
        )
          throw new Error('Fill timing or prediction scope is invalid.');
        if (batch.kind === 'EXECUTIONS') {
          if (fill.kind !== 'EXECUTED') throw new Error('Execution imports cannot contain simulated fills.');
          actual.push(fill);
        } else {
          if (fill.kind !== 'SIMULATED')
            throw new Error('Actual executions require a separately provenanced source document.');
          fills.push(fill);
        }
      }
      if (batch.kind === 'OBSERVATIONS') {
        for (const quote of batch.quotes) {
          if (quote.ask < quote.bid || Date.parse(quote.at) > Date.parse(receivedAt))
            throw new Error('Quote spread or observation time is invalid.');
          const key = quote.symbol + '@' + quote.at,
            previous = quotes.get(key);
          if (previous && canonical(previous) !== canonical(quote))
            throw new Error('Conflicting quote observations require a new branch, not replacement.');
          quotes.set(key, quote);
        }
        for (const [id, value] of Object.entries(batch.outcomes)) {
          const prediction = predictions.get(id);
          if (!prediction || Date.parse(prediction.forecastFor) > Date.parse(receivedAt))
            throw new Error('Outcome precedes its prospective prediction or forecast time.');
          if (id in outcomes && outcomes[id] !== value)
            throw new Error('A realised outcome cannot be silently revised.');
          outcomes[id] = value;
        }
      }
    }
    if (predictions.size > 100000 || quotes.size > 100000 || fills.length + actual.length > 100000)
      throw new Error(
        'Shadow ledger exceeds the bounded evaluation inventory. Split the registered monitoring window.',
      );
  }
  return {
    predictions: [...predictions.values()],
    quotes: [...quotes.values()],
    fills,
    actual,
    outcomes,
    verdict: evaluateShadow({
      predictions: [...predictions.values()],
      quotes: [...quotes.values()],
      fills,
      policy,
      outcomes,
      now,
    }),
  };
}
