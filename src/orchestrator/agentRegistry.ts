/**
 * Coordination layer — multi-agent registry.
 *
 * The daemon holds every wired AgentAdapter and resolves which one to use per
 * dispatch (repo override → daemon default). Replaces a single hard-wired
 * adapter so phone UI / repos.yaml can choose without a process restart.
 */
import type { AgentAdapter } from './adapter.js';
import {
  isAdapterKind,
  resolveAdapterKind,
  type AdapterKind,
  ADAPTER_KINDS,
} from '../domain/agents.js';

export class AgentRegistryError extends Error {
  override readonly name = 'AgentRegistryError';
}

export interface AgentProviderPolicy {
  readonly codex: {
    readonly model: string;
    readonly reasoningEffort: string;
  };
  readonly claudeEnabled: boolean;
}

const DEFAULT_PROVIDER_POLICY: AgentProviderPolicy = {
  codex: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
  claudeEnabled: false,
};

export class AgentRegistry {
  private readonly byName: ReadonlyMap<string, AgentAdapter>;
  readonly defaultKind: AdapterKind;
  readonly providerPolicy: AgentProviderPolicy;

  constructor(
    adapters: ReadonlyMap<string, AgentAdapter> | Readonly<Record<string, AgentAdapter>>,
    defaultKind: AdapterKind,
    providerPolicy: AgentProviderPolicy = DEFAULT_PROVIDER_POLICY,
  ) {
    this.byName =
      adapters instanceof Map
        ? adapters
        : new Map(Object.entries(adapters));
    if (!this.byName.has(defaultKind)) {
      throw new AgentRegistryError(`default adapter '${defaultKind}' is not registered`);
    }
    this.defaultKind = defaultKind;
    this.providerPolicy = providerPolicy;
  }

  /** Convenience: a registry that only knows one adapter (tests / fake-only). */
  static of(adapter: AgentAdapter): AgentRegistry {
    const kind = isAdapterKind(adapter.name) ? adapter.name : 'fake';
    // If the adapter uses a non-standard name, still register under that name and
    // treat default as that string only if it is a known kind — else wrap as fake slot.
    if (!isAdapterKind(adapter.name)) {
      return new AgentRegistry(new Map([['fake', adapter]]), 'fake');
    }
    return new AgentRegistry(new Map([[kind, adapter]]), kind);
  }

  /** Registered adapter names (stable sort for UI). */
  available(): readonly AdapterKind[] {
    return ADAPTER_KINDS.filter((k) => this.byName.has(k));
  }

  has(kind: string): boolean {
    return this.byName.has(kind);
  }

  /**
   * Resolve the adapter for a repo's optional override.
   * Falls back to the daemon default when override is null/unknown/unregistered.
   */
  resolve(requested: string | null | undefined): { kind: AdapterKind; adapter: AgentAdapter } {
    let kind = resolveAdapterKind(requested, this.defaultKind);
    if (!this.byName.has(kind)) kind = this.defaultKind;
    const adapter = this.byName.get(kind);
    if (!adapter) {
      throw new AgentRegistryError(`adapter '${kind}' missing after resolve`);
    }
    return { kind, adapter };
  }
}
