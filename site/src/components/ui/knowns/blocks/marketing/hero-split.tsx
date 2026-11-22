"use client";
/** @registry name="hero-split" type="block" title="Hero Split" description="Hero with copy beside fixed-aspect lazy media (image, video or any node). Builds on hero." */

/**
 * Hero, split: copy beside media (image, live component or video poster), media on either side.
 * Builds on ./hero (Free); this layout is Knowns UI Pro.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/knowns/utils";
import { Actions, Backdrop, CommandChip, Eyebrow, Facts, isFrameProps, Lead, Title, type HeroCopy } from "./hero";
import { MediaFrame, type MediaFrameProps } from "./section-heading";

export interface HeroSplitProps extends HeroCopy {
  /** An image or video (MediaFrame props), or any live content. */
  media: ReactNode | MediaFrameProps;
  /** The side the media sits on from 1024px. Default "right". */
  mediaSide?: "left" | "right";
  /** Small print under the actions. */
  footnote?: ReactNode;
  background?: ReactNode;
  className?: string;
}

export function HeroSplit({ eyebrow, title, rotate, rotateAuto, as, lead, primary, secondary, command, facts, media, mediaSide = "right", footnote, background, className }: HeroSplitProps) {
  return (
    <section data-slot="hero" data-variant="split" className={cn("relative isolate overflow-hidden", className)}>
      <Backdrop>{background}</Backdrop>
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-2 lg:gap-16">
        <div className={cn("flex flex-col items-start gap-6", mediaSide === "left" && "lg:order-2")}>
          {eyebrow && <Eyebrow eyebrow={eyebrow} />}
          <Title title={title} rotate={rotate} rotateAuto={rotateAuto} as={as} className="text-[48px] leading-[1.04] sm:text-[56px]" />
          <Lead className="max-w-xl">{lead}</Lead>
          <div className="mt-2 flex w-full min-w-0 flex-col items-start gap-6">
            <Actions primary={primary} secondary={secondary} />
            {command && <CommandChip command={command} />}
          </div>
          {footnote && <p className="text-[13px] text-muted-foreground">{footnote}</p>}
          <Facts facts={facts} />
        </div>
        <div className={cn("min-w-0", mediaSide === "left" && "lg:order-1")}>{isFrameProps(media) ? <MediaFrame {...media} /> : media}</div>
      </div>
    </section>
  );
}
