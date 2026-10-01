import { parseStrictJson } from '../core/strict-json';
import {
  diagnosticPolicySchema,
  judgeDiagnostic,
  judgeStress,
  assertForecastSeparateFromEconomics,
} from '../shared/research-diagnostics';
import type { FrozenResearchSpec } from '../shared/research';
import type { RunReturnInspection } from '../shared/run-package';

/** Opt-in policy in the existing frozen Metrics and gates section; never inferred from results. */
export const DIAGNOSTIC_POLICY_PREFIX = 'diagnostic-policy@1\n';
export function judgeReturnedAnalysis(
  spec: FrozenResearchSpec,
  returned: Pick<RunReturnInspection, 'objects' | 'manifestHash'>,
) {
  if (!spec.sections.metricsAndGates.startsWith(DIAGNOSTIC_POLICY_PREFIX)) return null;
  if (!spec.frozen) throw new Error('Diagnostic policy must come from the frozen specification.');
  const policy = diagnosticPolicySchema.parse(
    parseStrictJson(spec.sections.metricsAndGates.slice(DIAGNOSTIC_POLICY_PREFIX.length)),
  );
  const read = (name: string) => {
    const object = returned.objects.find(o => o.path === name);
    if (!object) throw new Error(`Registered analysis needs ${name} in the bound return.`);
    const parsed = parseStrictJson(Buffer.from(object.bytes).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error(`${name} must contain a JSON object.`);
    return parsed as Record<string, unknown>;
  };
  const bind = (report: Record<string, unknown>) => {
    if (report.receiptHash !== undefined && report.receiptHash !== returned.manifestHash)
      throw new Error('Analysis report names a different return receipt.');
    return { ...report, receiptHash: returned.manifestHash };
  };
  const forecast = read('outputs/diagnostics.json');
  assertForecastSeparateFromEconomics(forecast);
  const economics = read('outputs/economics.json');
  if (!economics.stressReport || typeof economics.stressReport !== 'object' || Array.isArray(economics.stressReport))
    throw new Error('Registered analysis needs a structured stressReport in outputs/economics.json.');
  const diagnostic = judgeDiagnostic(bind(forecast), policy);
  const stress = judgeStress(bind(economics.stressReport as Record<string, unknown>), policy);
  return { diagnostic, stress, adequate: diagnostic.adequate && stress.adequate };
}
