import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
  private readonly isolationFile: string;
  private unavailableLogged = false;
  private unreadableLogged = false;
  constructor(
    root: string,
    private readonly box: SecretBox = electronSecretBox(),
    private readonly log?: (line: string) => void,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.file = path.join(root, 'secrets.dat');
    this.isolationFile = path.join(root, 'agent-isolation.json');
  }
  /**
   * Unreadable credentials remain byte-for-byte in place for recovery. Reads may report missing
   * keys, but mutations must refuse rather than overwrite other keys with an empty payload.
   */
  private read(forWrite = false): SecretsFile {
    if (!existsSync(this.file)) return EMPTY;
    if (!this.box.available()) {
      if (!this.unavailableLogged) {
        this.unavailableLogged = true;
        this.log?.('secrets: encrypted storage is unavailable; saved keys are not readable this session');
      }
      if (forWrite) throw new Error('Windows encrypted storage is unavailable; the key was not saved.');
      return EMPTY;
    }
    try {
      const blob = Buffer.from(readFileSync(this.file, 'utf8').trim(), 'base64');
      return parseFile(JSON.parse(this.box.decrypt(blob)));
    } catch {
      if (!this.unreadableLogged) {
        this.unreadableLogged = true;
        this.log?.('secrets: secrets.dat could not be decrypted or parsed; preserved for recovery');
      }
      if (forWrite)
        throw new Error('Saved credentials could not be read; restore encrypted storage before changing keys.');
      return EMPTY;
    }
  }
  private writeIsolationRequired(required: boolean): void {
    mkdirSync(path.dirname(this.isolationFile), { recursive: true });
    const tmp = `${this.isolationFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, required }), 'utf8');
    renameSync(tmp, this.isolationFile);
  }
  /**
   * Dispatch intent is independent of DPAPI availability. Existing readable credentials migrate
   * on first use. Unreadable legacy files (including old quarantined files) conservatively require
   * isolation until the user explicitly disables it; they must never authorize self execution.
   */
  isolationRequired(): boolean {
    try {
      const state = JSON.parse(readFileSync(this.isolationFile, 'utf8'));
      if (state.version === 1 && typeof state.required === 'boolean') return state.required;
      return true;
    } catch (error) {
      // Only actual absence permits legacy migration. Access errors cannot authorize a downgrade.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
    let required = false;
    try {
      try {
        statSync(this.file);
        required = Boolean(this.read(true).agentUser);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') required = true;
      }
      if (!required && existsSync(path.dirname(this.file)))
        required = readdirSync(path.dirname(this.file)).some(name => /^secrets\.broken-.+\.dat$/.test(name));
    } catch {
      required = true;
    }
    if (required) {
      try {
        this.writeIsolationRequired(true);
      } catch {
        // Still require the isolated route in this session; the legacy bytes survive restart.
      }
    }
    return required;
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
    return this.read(true).providers[provider]?.key ?? null;
  }
  saveProviderKey(provider: Provider, key: string): void {
    if (!key) throw new Error('An empty key was not saved.');
    const current = this.read(true);
    this.write({ ...current, providers: { ...current.providers, [provider]: { key, savedAt: this.now() } } });
  }
  removeProviderKey(provider: Provider): void {
    const current = this.read(true);
    if (!(provider in current.providers)) return;
    const providers = { ...current.providers };
    delete providers[provider];
    this.write({ ...current, providers });
  }
  providerKeyState(provider: Provider): { saved: boolean; savedAt?: string } {
    // This also chooses the subscription observation mode; unreadability must never mean absent.
    const entry = this.read(true).providers[provider];
    return entry ? { saved: true, savedAt: entry.savedAt } : { saved: false };
  }
  /** Credential availability only. Dispatch must consult isolationRequired instead. */
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
    const current = this.read(true);
    // Persist intent first: a crash or failed encrypted write may block, but cannot downgrade.
    this.writeIsolationRequired(true);
    this.write({ ...current, agentUser: { user, password, savedAt: this.now() } });
  }
  /**
   * Drops the agent credential — the office stops launching agents as the separate account. The
   * Windows account itself is deliberately left in place (removing it is a Windows admin action,
   * never something this office does silently).
   */
  removeAgentUser(): void {
    let current: SecretsFile | undefined;
    try {
      current = this.read(true);
    } catch {
      // Explicit disable remains possible when DPAPI is unavailable. Preserve recovery bytes.
    }
    if (current?.agentUser) {
      const next = { ...current };
      delete next.agentUser;
      this.write(next);
    }
    this.writeIsolationRequired(false);
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
