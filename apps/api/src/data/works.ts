import { z } from "zod";
import { detectives } from "./detectives.js";
import rawDetails from "./core-work-details.json" with { type: "json" };

const workLinkSchema = z.object({
  linkType: z.enum([
    "PUBLISHER",
    "BOOKSTORE",
    "LIBRARY",
    "STREAMING",
    "OFFICIAL_SITE",
    "OTHER"
  ]),
  providerName: z.string().min(1),
  url: z.url(),
  region: z.string().min(1).max(30),
  lastCheckedAt: z.iso.date()
});

const detailSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  summary: z.string().min(1),
  links: z.array(workLinkSchema).min(1)
});

const details = z.array(detailSchema).parse(rawDetails);
const detailsBySlug = new Map(details.map((detail) => [detail.slug, detail]));

export const works = detectives.flatMap((detective) =>
  detective.works.map((work) => {
    const detail = detailsBySlug.get(work.slug);
    if (!detail) {
      throw new Error(`Missing core work detail: ${work.slug}`);
    }
    return {
      ...work,
      summary: detail.summary,
      coverUrl: null,
      creators: [{ nameZh: work.creatorName, creditType: "AUTHOR" }],
      detectives: [{ slug: detective.slug, nameZh: detective.nameZh }],
      links: detail.links
    };
  })
);

if (new Set(works.map((work) => work.slug)).size !== works.length) {
  throw new Error("Core work slugs must be unique");
}
