/** The features that ship inside Nookdeck. Each has its own page under Plugins (hash `#plugin/<id>`); community plugins use `#plugin/<their id>`. */
export const BUILTIN_PLUGINS = [
  { id: "claude", name: "Claude Code", icon: "claude", desc: "Quota, sessions and permission prompts on the phone" },
  { id: "codex", name: "Codex", icon: "codex", desc: "Quota, sessions and permission prompts on the phone" },
  { id: "grok", name: "Grok", icon: "grok", desc: "Sessions and usage on the phone" },
  { id: "antigravity", name: "Antigravity", icon: "antigravity", desc: "Quota on the phone" },
  { id: "opencode", name: "OpenCode", icon: "opencode", desc: "Sessions and cost on the phone" },
  { id: "hass", name: "Home Assistant", icon: "home", desc: "Lights, switches, scenes and sensors" },
  { id: "onair", name: "On Air", icon: "radio", desc: "A red light on the phone while you are live, recording or in a call" },
  { id: "weather", name: "Weather", icon: "sun", desc: "Forecast tiles and the temperature unit" },
  { id: "quota", name: "AI usage", icon: "gauge", desc: "How much of your AI usage window is left" },
] as const;
export type BuiltinId = (typeof BUILTIN_PLUGINS)[number]["id"];
export const AI_TOOL_IDS = ["claude", "codex", "grok", "antigravity", "opencode"] as const;
