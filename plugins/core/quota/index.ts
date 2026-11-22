/** core.quota: the AI usage tile, behind the plugin API. Reads what the AI hub already collected (custom:quota). */
import type { PluginModule } from "../../../src/plugins/api";
import type { ProviderQuota } from "../../../src/ai/types";

export interface QuotaDeps {
  /** The hub's current block for one provider. */
  quota(provider: string): ProviderQuota | undefined;
}

export function makeQuotaPlugin(deps: QuotaDeps): PluginModule {
  return {
    activate(ctx) {
      ctx.widgets.provide("quota", (s) => {
        const q = deps.quota(typeof s.provider === "string" ? s.provider : "claude");
        if (!q) throw new Error("unknown provider");
        return { render: "text", data: q };
      }, { every: 60 });
    },
  };
}
