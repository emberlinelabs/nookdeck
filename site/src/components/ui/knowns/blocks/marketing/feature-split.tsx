"use client";
/** @registry name="feature-split" type="block" title="Feature split" description="Alternating rows of text beside media, each with an optional checklist, stat and link. Media in lazy, fixed-aspect frames; it stacks under the text on phones." */

/**
 * FeatureSplit: rows of text beside media, alternating sides. Each row can carry a checklist, a stat
 * and a link. Media sits in fixed-aspect frames (lazy images, video posters or live components), so
 * nothing shifts as it loads; on phones the media goes under the text.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/knowns/utils";
import { ArrowLink, MediaFrame, SectionHeading, type MediaFrameProps } from "./section-heading";
import { mediaSide, type MarketingAction } from "./marketing-utils";

export type { MarketingAction } from "./marketing-utils";
export { MediaFrame } from "./section-heading";

export interface FeatureRow {
  eyebrow?: ReactNode;
  title: string;
  text: ReactNode;
  /** Short points with a check mark. */
  checklist?: string[];
  /** One number that backs the claim, e.g. { value: "4x", label: "faster reviews" }. */
  stat?: { value: string; label: string };
  link?: MarketingAction;
  /** An image or video (MediaFrame props), or any live content. */
  media: ReactNode | MediaFrameProps;
}

export interface FeatureSplitProps {
  eyebrow?: ReactNode;
  title?: ReactNode;
  lead?: ReactNode;
  rows: FeatureRow[];
  /** The side of the first row's media. Default "right". */
  start?: "left" | "right";
  /** Section padding: "default" 64 / 96px (phone / desktop), "tight" 40 / 56px for use inside a page or a frame. */
  spacing?: "default" | "tight";
  className?: string;
}

const isFrameProps = (m: FeatureRow["media"]): m is MediaFrameProps =>
  !!m && typeof m === "object" && !("$$typeof" in (m as object)) && ("src" in (m as object) || "video" in (m as object));

const Check = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mt-1 size-4 flex-none">
    <circle cx="8" cy="8" r="7.25" strokeWidth="1" className="stroke-border" />
    <path d="m5 8.25 2 2 4-4.5" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="stroke-[color:var(--kn-accent,var(--primary))]" />
  </svg>
);

export function FeatureSplit({ eyebrow, title, lead, rows, start = "right", spacing = "default", className }: FeatureSplitProps) {
  return (
    <section data-slot="feature-split" className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", spacing === "tight" ? "py-10 sm:py-14" : "py-16 sm:py-24", className)}>
      <SectionHeading eyebrow={eyebrow} title={title} lead={lead} className={spacing === "tight" ? "mb-10 sm:mb-12" : "mb-16 sm:mb-20"} />
      <div className={cn("flex flex-col", spacing === "tight" ? "gap-12 sm:gap-16" : "gap-16 sm:gap-24")}>
        {rows.map((row, i) => {
          const left = mediaSide(i, start) === "left";
          return (
            <article key={row.title} className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
              <div className={cn("flex flex-col items-start gap-4", left && "lg:order-2")}>
                {row.eyebrow && <p className="text-[14px] font-semibold text-[color:var(--kn-accent,var(--primary))]">{row.eyebrow}</p>}
                <h3 className="text-balance text-[24px] leading-8 font-semibold">{row.title}</h3>
                <p className="text-pretty text-[16px] leading-7 text-muted-foreground">{row.text}</p>
                {row.checklist && row.checklist.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-3">
                    {row.checklist.map((c) => (
                      <li key={c} className="flex gap-3 text-[15px] leading-6">
                        <Check />
                        {c}
                      </li>
                    ))}
                  </ul>
                )}
                {row.stat && (
                  <p className="mt-2 flex items-baseline gap-2 border-l pl-4">
                    <span className="text-[24px] leading-8 font-semibold tabular-nums">{row.stat.value}</span>
                    <span className="text-[14px] text-muted-foreground">{row.stat.label}</span>
                  </p>
                )}
                {row.link && <ArrowLink action={row.link} className="mt-2" />}
              </div>
              <div className={cn("min-w-0", left && "lg:order-1")}>{isFrameProps(row.media) ? <MediaFrame {...row.media} /> : row.media}</div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
