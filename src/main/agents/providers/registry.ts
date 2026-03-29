import type { AgentProvider, AgentProviderConfig } from "../types";

export class AgentProviderRegistry {
  private providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): void {
    if (this.providers.has(provider.config.id)) {
      throw new Error(`Provider "${provider.config.id}" is already registered`);
    }
    this.providers.set(provider.config.id, provider);
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): AgentProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): AgentProvider[] {
    return Array.from(this.providers.values());
  }

  async listAvailable(): Promise<AgentProviderConfig[]> {
    const results: AgentProviderConfig[] = [];
    for (const provider of this.providers.values()) {
      if (await provider.isAvailable()) {
        results.push(provider.config);
      }
    }
    return results;
  }
}
