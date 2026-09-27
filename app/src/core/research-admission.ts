import { createPublicKey, verify } from 'node:crypto';
import { canonical } from './canonical';
import {
  signedResearchClaimSchema,
  type ResearchTrustPin,
  type SignedResearchClaim,
} from '../shared/research-admission';

/** Trust anchors live outside restorable research records and candidate-writable scopes. */
export class ResearchAdmission {
  private readonly pins: readonly ResearchTrustPin[];
  constructor(pins: readonly ResearchTrustPin[] = []) {
    this.pins = structuredClone(pins);
    if (new Set(pins.map(p => p.keyId)).size !== pins.length) throw new Error('Duplicate research trust anchor.');
    for (const pin of pins) {
      if (createPublicKey(pin.publicKeyPem).asymmetricKeyType !== 'ed25519')
        throw new Error('Research admission requires Ed25519 keys.');
      if ((pin.environment === 'LOCAL_FIXTURE') !== (pin.route === 'FAKE_ADAPTER'))
        throw new Error('Fixture trust cannot attest a hosted route.');
    }
  }
  get configured() {
    return this.pins.length > 0;
  }
  verify(input: unknown): {
    signed: SignedResearchClaim;
    environment: ResearchTrustPin['environment'];
    route: ResearchTrustPin['route'];
  } {
    const signed = signedResearchClaimSchema.parse(input),
      pin = this.pins.find(p => p.keyId === signed.claim.keyId);
    if (Date.parse(signed.claim.issuedAt) > Date.now() + 60000)
      throw new Error('Independent receipt is dated in the future.');
    if (!pin || pin.harnessHash !== signed.claim.harnessHash)
      throw new Error('Independent harness trust anchor is missing or differs from its pinned version.');
    if (
      !verify(
        null,
        Buffer.from(canonical(signed.claim)),
        createPublicKey(pin.publicKeyPem),
        Buffer.from(signed.signature, 'base64'),
      )
    )
      throw new Error('Independent harness signature is invalid. Provider-written verdicts cannot approve gates.');
    if (signed.claim.kind === 'ISOLATION' && signed.claim.route !== pin.route)
      throw new Error('Isolation receipt route differs from the trust anchor.');
    return { signed, environment: pin.environment, route: pin.route };
  }
}
