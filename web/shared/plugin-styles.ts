/**
 * The ONE table of display styles for plugin tiles. Imported by the agent (src/config.ts STYLES), the deck (plugin-logic.ts) and the manage
 * Style picker. The first style of each renderer is its default (what plugins looked like before styles). A tile picks one with
 * plugin.view.style; a manifest suggests one with widgets[].style. Data only, no imports: keep it that way so every side can use it.
 */
export const PLUGIN_STYLES: { [render: string]: string[] } = {
  stat: ["plain", "spark", "big"],
  gauge: ["arc", "ring", "half", "bar"],
  text: ["plain", "minimal"],
  list: ["rows", "compact"],
  chart: ["line", "area", "bars", "dots"],
  image: ["cover", "contain"],
  status: ["card", "pill", "dot"],
};
