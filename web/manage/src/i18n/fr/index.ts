import { FR_APP } from "./app";
import { FR_EDITOR } from "./editor";
import { FR_PALETTE } from "./palette";
import { FR_SCREENS } from "./screens";
import { FR_AUTOMATION } from "./automation";
import { FR_PLUGINS } from "./plugins";
import { FR_THEMES } from "./themes";
import { FR_LIVE } from "./live";

/** English text -> French. One file per area so they can be edited independently. */
export const FR: Record<string, string> = { ...FR_APP, ...FR_EDITOR, ...FR_PALETTE, ...FR_SCREENS, ...FR_AUTOMATION, ...FR_PLUGINS, ...FR_THEMES, ...FR_LIVE };
