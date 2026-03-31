import type { AgentFrameworkConfig, AgentProvider } from "./types";
import { createLogger } from "../services/logger";

const log = createLogger("private-providers");

type ProviderFactory = {
  default: (config: AgentFrameworkConfig) => AgentProvider;
};

const modules = import.meta.glob("../../agents-private/*/index.ts", { eager: true }) as Record<
  string,
  ProviderFactory
>;

export function discoverPrivateProviders(config: AgentFrameworkConfig): AgentProvider[] {
  const providers: AgentProvider[] = [];
  for (const [modulePath, mod] of Object.entries(modules)) {
    if (mod.default) {
      try {
        providers.push(mod.default(config));
      } catch (err) {
        log.warn(
          { err: err },
          `[PrivateProviders] Failed to initialize provider from ${modulePath}`,
        );
      }
    }
  }
  return providers;
}
