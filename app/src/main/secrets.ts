import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { subscriptionEnvironment } from './subscriptions.js';
import type { Provider } from '../shared/types.js';

/**
 * The encryption primitive secrets.dat is written through. In the app this is Electron
 * safeStorage (Windows DPAPI under the user's own login); tests inject a stub so `node:test`
 * can exercise this module without Electron.
 */
export interface SecretBox {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
}

/**
 * Electron safeStorage behind the SecretBox interface. Electron is loaded lazily so this module
 * imports cleanly under plain node for tests — the require only runs inside a real app process,
 * and every failure reports unavailable rather than crashing open.
 */
function electronSecretBox(): SecretBox {
  let safeStorage: typeof import('electron').safeStorage | undefined;
  const load = () => (safeStorage ??= (require('electron') as typeof import('electron')).safeStorage);
  return {
    available: () => {
      try {
        return load().isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt: plain => load().encryptString(plain),
    decrypt: blob => load().decryptString(blob),
  };
}

interface StoredProviderKey {
  key: string;
  savedAt: string;
}

/** The decrypted secrets.dat payload. `agentUser` is reserved for LR-16 and unused in LR-15. */
interface SecretsFile {
  version: 1;
  providers: Partial<Record<Provider, StoredProviderKey>>;
  agentUser?: { user: string; password: string; savedAt: string };
}

const EMPTY: SecretsFile = { version: 1, providers: {} };

function parseFile(parsed: unknown): SecretsFile {
  const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  if (root.version !== 1 || !root.providers || typeof root.providers !== 'object' || Array.isArray(root.providers))
    throw new Error('unrecognized payload');
  const providers: SecretsFile['providers'] = {};
  for (const [name, value] of Object.entries(root.providers as Record<string, unknown>)) {
    const entry = value as Partial<StoredProviderKey> | null;
    if (
      (name !== 'openai' && name !== 'claude' && name !== 'devin') ||
      !entry ||
      typeof entry.key !== 'string' ||
      typeof entry.savedAt !== 'string'
    )
      throw new Error('unrecognized provider entry');
    providers[name] = { key: entry.key, savedAt: entry.savedAt };
  }
  const agentUser = root.agentUser as SecretsFile['agentUser'];
  if (
    agentUser !== undefined &&
    (typeof agentUser?.user !== 'string' ||
      typeof agentUser?.password !== 'string' ||
      typeof agentUser?.savedAt !== 'string')
  )
    throw new Error('unrecognized agentUser entry');
  return { version: 1, providers, ...(agentUser ? { agentUser } : {}) };
}

/**
 * The local secrets file: `secrets.dat` directly under `app.getPath('userData')` — a sibling of
 * `workspace/`, never inside it — holding only `box.encrypt(JSON.stringify(payload))` as base64
 * text. Keys are never written to the workspace, logs, Git or prompts; presence of a saved
 * provider key IS the api-key auth mode (machine-local config, not office state).
 */
export class Secrets {
  private readonly file: string;
  private unavailableLogged = false;
  constructor(
    root: string,
    private readonly box: SecretBox = electronSecretBox(),
    private readonly log?: (line: string) => void,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.file = path.join(root, 'secrets.dat');
  }
  /**
   * The decrypted payload, or the empty state when the file is absent. An undecryptable or
   * corrupt file is renamed aside to `secrets.broken-<ISO-ts>.dat` once, logged once, and read as
   * empty — secrets never crash open. A box that reports unavailable leaves the file alone: it
   * may be perfectly readable on the next launch, so nothing is renamed.
   */
  private read(): SecretsFile {
    if (!existsSync(this.file)) return EMPTY;
    if (!this.box.available()) {
      if (!this.unavailableLogged) {
        this.unavailableLogged = true;
        this.log?.('secrets: encrypted storage is unavailable; saved keys are not readable this session');
      }
      return EMPTY;
    }
    try {
      const blob = Buffer.from(readFileSync(this.file, 'utf8').trim(), 'base64');
      return parseFile(JSON.parse(this.box.decrypt(blob)));
    } catch {
      const broken = `secrets.broken-${this.now().replaceAll(':', '-')}.dat`;
      try {
        renameSync(this.file, path.join(path.dirname(this.file), broken));
      } catch {
        /* a failed rename still leaves the file unreadable, which is the honest empty state */
      }
      this.log?.(`secrets: secrets.dat could not be decrypted or parsed; renamed to ${broken}`);
      return EMPTY;
    }
  }
  /** Writes are atomic-ish: encrypt to secrets.dat.tmp, then rename over secrets.dat. */
  private write(payload: SecretsFile): void {
    if (!this.box.available()) throw new Error('Windows encrypted storage is unavailable; the key was not saved.');
    mkdirSync(path.dirname(this.file), { recursive: true });
    const blob = this.box.encrypt(JSON.stringify(payload));
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, blob.toString('base64'), 'utf8');
    renameSync(tmp, this.file);
  }
  // Returns plaintext — callers may hand it to process env only; never log, persist, serialize or send it.
  providerKey(provider: Provider): string | null {
    return this.read().providers[provider]?.key ?? null;
  }
  saveProviderKey(provider: Provider, key: string): void {
    if (!key) throw new Error('An empty key was not saved.');
    const current = this.read();
    this.write({ ...current, providers: { ...current.providers, [provider]: { key, savedAt: this.now() } } });
  }
  removeProviderKey(provider: Provider): void {
    const current = this.read();
    if (!(provider in current.providers)) return;
    const providers = { ...current.providers };
    delete providers[provider];
    this.write({ ...current, providers });
  }
  providerKeyState(provider: Provider): { saved: boolean; savedAt?: string } {
    const entry = this.read().providers[provider];
    return entry ? { saved: true, savedAt: entry.savedAt } : { saved: false };
  }
  /** The LR-16 low-privilege agent account credential — presence IS the isolation mode. */
  hasAgentCredential(): boolean {
    return Boolean(this.read().agentUser);
  }
  agentCredential(): { user: string; password: string; savedAt: string } | null {
    return this.read().agentUser ?? null;
  }
  /**
   * Saves the agent account credential after the consented elevated setup reports ok. The password
   * is machine-generated for exactly this local account — it is handed to the credential-launch
   * bootstrap's stdin only and is never logged, rendered or written anywhere else.
   */
  saveAgentUser(user: string, password: string): void {
    if (!user || !password) throw new Error('An agent account name and password are required.');
    const current = this.read();
    this.write({ ...current, agentUser: { user, password, savedAt: this.now() } });
  }
  /**
   * Drops the agent credential — the office stops launching agents as the separate account. The
   * Windows account itself is deliberately left in place (removing it is a Windows admin action,
   * never something this office does silently).
   */
  removeAgentUser(): void {
    const current = this.read();
    if (!current.agentUser) return;
    const next = { ...current };
    delete next.agentUser;
    this.write(next);
  }
}

/**
 * The environment a provider CLI is spawned with on the office's local-exec route: the
 * subscription scrub, plus exactly one provider key variable when the user saved their own key.
 * claude → ANTHROPIC_API_KEY, openai → OPENAI_API_KEY, devin → DEVIN_API_KEY — the variable each
 * official CLI reads for API-key auth. Without a saved key this is exactly
 * subscriptionEnvironment(): subscription mode is unchanged.
 */
export function agentEnvironment(
  provider: Provider,
  keys: { providerKey(provider: Provider): string | null },
): NodeJS.ProcessEnv {
  const env = subscriptionEnvironment();
  const key = keys.providerKey(provider);
  if (key) env[{ claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', devin: 'DEVIN_API_KEY' }[provider]] = key;
  return env;
}
