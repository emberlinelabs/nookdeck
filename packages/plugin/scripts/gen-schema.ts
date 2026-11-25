// Generates schema/nookdeck.schema.json from the validator's own constants (src/plugins/types.ts), so the two cannot drift
// on renderers or setting types. Run: bun packages/plugin/scripts/gen-schema.ts [--check]
import { RENDERERS, SETTING_TYPES } from "../../../src/plugins/types";
import { PLUGIN_STYLES } from "../../../web/shared/plugin-styles";

const idPart = "^[a-z0-9][a-z0-9_-]{0,47}$";
const settingField = {
  type: "object",
  required: ["key", "type"],
  additionalProperties: false,
  properties: {
    key: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,47}$" },
    type: { enum: [...SETTING_TYPES], description: "secret is write-only: phones never see it. entity picks a Home Assistant entity." },
    label: { type: "string", maxLength: 80 },
    default: { type: ["string", "number", "boolean"], description: "Must match the type. A secret has no default." },
    options: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50, description: "Required for select." },
  },
};
const settings = { type: "array", items: { $ref: "#/$defs/settingField" }, maxItems: 20 };
const every = { type: "integer", minimum: 5, maximum: 86400, description: "Seconds between refreshes." };

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://nookdeck.app/schema/plugin.json",
  title: "Nookdeck plugin manifest (nookdeck.json)",
  type: "object",
  required: ["id", "name", "version"],
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,31}(\\.[a-z0-9][a-z0-9_-]{0,47}){1,4}$", description: "Reverse-DNS style, dev.<author>.<name>. core.* is reserved." },
    name: { type: "string", minLength: 1, maxLength: 60 },
    version: { type: "string", pattern: "^\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}(-[0-9A-Za-z.-]{1,20})?$" },
    nookdeck: { type: "string", pattern: "^[>=^~\\s]*\\d+(\\.\\d+){0,2}\\s*$", description: 'Nookdeck versions the plugin works with, for example ">=0.2.0".' },
    author: { type: "string", maxLength: 80 },
    description: { type: "string", maxLength: 300 },
    icon: { type: "string", maxLength: 140, description: "A file in the plugin folder, or an icon name." },
    permissions: { $ref: "#/$defs/permissions" },
    settings,
    widgets: { type: "array", items: { $ref: "#/$defs/widget" }, maxItems: 20 },
    actions: { type: "array", items: { $ref: "#/$defs/action" }, maxItems: 20 },
    themes: { type: "array", maxItems: 20, items: { type: "object", required: ["id", "theme"], properties: { id: { type: "string", pattern: idPart }, name: { type: "string", maxLength: 60 }, theme: { type: "object", description: "A Nookdeck theme object (same as layout.theme)." } }, additionalProperties: false } },
    layouts: { type: "array", maxItems: 10, items: { type: "object", required: ["id", "layout"], properties: { id: { type: "string", pattern: idPart }, name: { type: "string", maxLength: 60 }, layout: { type: "object", description: "A Nookdeck layout object." } }, additionalProperties: false } },
    os: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["darwin", "win32", "linux"] }, description: "The systems the plugin works on. Leave it out when it works everywhere." },
    main: { type: ["string", "null"], description: "Entry module of a code plugin (JS or TS) that exports activate(ctx). Omit or null for a no-code plugin." },
  },
  $defs: {
    permissions: {
      type: "object",
      additionalProperties: false,
      properties: {
        network: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", pattern: "^(\\*\\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$" }, description: "Host names the plugin may call: api.example.com or *.example.com." },
        shell: { type: "boolean", description: "Run commands on this computer." },
        keyboard: { type: "boolean", description: "Press keys and type text on this computer." },
        storage: { type: "boolean", description: "Keep its own saved data." },
      },
    },
    settingField: settingField,
    widget: {
      type: "object",
      required: ["id", "render"],
      additionalProperties: false,
      properties: {
        id: { type: "string", pattern: idPart },
        name: { type: "string", maxLength: 60 },
        render: { enum: [...RENDERERS] },
        sizes: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", pattern: "^[1-9]\\d?x[1-9]\\d?$" }, description: 'For example "2x1".' },
        preview: { description: "Sample data for the renderer, shown in the Store and the tile picker before the plugin runs." },
        style: { enum: [...new Set(Object.values(PLUGIN_STYLES).flat())], description: "Suggested display style (one of the renderer's styles); a tile's own choice overrides it." },
        settings,
        source: {
          description: "Where the data comes from. Required for a no-code plugin; a code plugin provides the widget from activate().",
          oneOf: [
            { type: "object", required: ["http"], additionalProperties: false, properties: { http: { type: "object", required: ["url"], additionalProperties: false, properties: { url: { type: "string", maxLength: 1000, description: "Fixed host; {{setting}} allowed after it." }, every, headers: { type: "object", additionalProperties: { type: "string", maxLength: 500 }, maxProperties: 10 } } }, map: { type: "object" } } },
            { type: "object", required: ["command"], additionalProperties: false, properties: { command: { type: "object", required: ["run"], additionalProperties: false, properties: { run: { type: "string", maxLength: 2000 }, every, parse: { enum: ["json", "text"] } } }, map: { type: "object" } } },
          ],
        },
      },
    },
    action: {
      type: "object",
      required: ["id", "run"],
      additionalProperties: false,
      properties: {
        id: { type: "string", pattern: idPart },
        name: { type: "string", maxLength: 60 },
        settings,
        run: {
          description: "No-code actions run a macro or one HTTP call. A code plugin handles the action in activate() and omits run.",
          oneOf: [
            { type: "object", required: ["macro"], additionalProperties: false, properties: { macro: { type: "array", items: { type: "object" }, description: "Macro steps (same as Automation). hass and item steps are not allowed." } } },
            { type: "object", required: ["http"], additionalProperties: false, properties: { http: { type: "object", required: ["url"], additionalProperties: false, properties: { url: { type: "string", maxLength: 1000 }, method: { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, headers: { type: "object", additionalProperties: { type: "string", maxLength: 500 }, maxProperties: 10 }, body: { type: "string", maxLength: 5000 } } } } },
          ],
        },
      },
    },
  },
};
// A code plugin has no source/run: relax the two "required" lists when main is set.
(schema.$defs.widget as any).required = ["id", "render"];
(schema.$defs.action as any).required = ["id"];

const out = JSON.stringify(schema, null, 2) + "\n";
const path = new URL("../schema/nookdeck.schema.json", import.meta.url).pathname;
if (process.argv.includes("--check")) {
  const cur = await Bun.file(path).text().catch(() => "");
  if (cur !== out) { console.error("schema/nookdeck.schema.json is out of date: run bun packages/plugin/scripts/gen-schema.ts"); process.exit(1); }
} else {
  await Bun.write(path, out);
  console.log("wrote", path);
}
