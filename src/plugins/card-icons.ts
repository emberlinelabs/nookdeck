/**
 * Card icon names the phone has no glyph for. A card has only the built-in icons (the agent sends no extra ones with card
 * data), and the phone draws an unknown name as a dim square, so the author is told.
 */
import { isIconName } from "../../web/shared/icons";
import type { CardNode } from "./card";

/** what the deck takes for an icon name (anything else, such as "OK", is drawn as the text itself): keep with web/deck/src/icon.tsx */
const LOOKS_LIKE_A_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function unknownCardIcons(root: CardNode | undefined): string[] {
  const out = new Set<string>();
  const walk = (n: CardNode): void => {
    if (n.t === "row" || n.t === "col") return n.children.forEach(walk);
    const name = n.t === "icon" ? n.name : n.t === "button" || n.t === "ring" ? n.icon : undefined;
    if (name && name.length >= 3 && LOOKS_LIKE_A_NAME.test(name) && !isIconName(name)) out.add(name);
  };
  if (root) walk(root);
  return [...out];
}

export const iconWarning = (name: string): string => `card icon "${name}" is not one of the built-in icons: the phone draws a dim square. See "Icons" in docs/plugins.md`;
