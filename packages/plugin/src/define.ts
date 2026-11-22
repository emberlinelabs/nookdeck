import type { PluginModule } from "../../../src/plugins/api";

/** Identity helper that gives editors types and completion: `export default definePlugin({ activate(ctx) { ... } })`. */
export const definePlugin = (m: PluginModule): PluginModule => m;
