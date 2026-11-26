import { PT_APP } from "./app";
import { PT_EDITOR } from "./editor";
import { PT_PALETTE } from "./palette";
import { PT_SCREENS } from "./screens";
import { PT_AUTOMATION } from "./automation";
import { PT_PLUGINS } from "./plugins";
import { PT_THEMES } from "./themes";

/** English text -> Brazilian Portuguese (pt-BR). One file per area so they can be edited independently. */
export const PT: Record<string, string> = { ...PT_APP, ...PT_EDITOR, ...PT_PALETTE, ...PT_SCREENS, ...PT_AUTOMATION, ...PT_PLUGINS, ...PT_THEMES };
