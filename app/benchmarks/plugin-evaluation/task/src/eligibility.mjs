// Starter implementation is intentionally incomplete; this is not production code.
export function classify(row) {
  return { id: row.id, eligible: row.observedAt <= row.decisionAt,
    reason: row.observedAt <= row.decisionAt ? 'OK' : 'LATE' };
}
