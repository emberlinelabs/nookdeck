import { ZH_APP } from "./app";
import { ZH_EDITOR } from "./editor";
import { ZH_PALETTE } from "./palette";
import { ZH_SCREENS } from "./screens";
import { ZH_AUTOMATION } from "./automation";
import { ZH_PLUGINS } from "./plugins";
import { ZH_THEMES } from "./themes";
import { ZH_LIVE } from "./live";

/** English text -> Simplified Chinese. One file per area so they can be edited independently. */
export const ZH: Record<string, string> = { ...ZH_APP, ...ZH_EDITOR, ...ZH_PALETTE, ...ZH_SCREENS, ...ZH_AUTOMATION, ...ZH_PLUGINS, ...ZH_THEMES, ...ZH_LIVE };
