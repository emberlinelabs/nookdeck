// @nookdeck/plugin: types and helpers for plugin authors.
//
// PluginContext, PluginModule, WidgetUpdate, the permission names and the limits are NOT declared here. They live in
// src/plugins/api.ts, the single source of truth the agent also uses, and are re-exported so a plugin and the agent can
// never disagree about them. (The file has no imports of the agent, only types.) The publish build must bundle its
// declarations into dist, because the path below only resolves inside this repo.
export * from "../../../src/plugins/api";
// the card renderer's builders and its check (handy in a plugin's own tests): card.col([...]), validateCard(data)
export { card, validateCard, CARD_LIMITS } from "../../../src/plugins/card";
export { definePlugin } from "./define";
