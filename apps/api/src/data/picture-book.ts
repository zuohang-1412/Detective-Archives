import { z } from "zod";
import rawCatalog from "./picture-book-index.json" with { type: "json" };

const verificationValueSchema = z.enum([
  "MISSING",
  "SOURCE_CAPTURED",
  "PRIMARY_SOURCE_CONFIRMED"
]);

const pictureBookEntrySchema = z.object({
  id: z.string().regex(/^PB-\d{3}-(STD|SP)$/),
  volumeNo: z.number().int().min(1),
  edition: z.enum(["STANDARD", "SPECIAL"]),
  names: z.object({
    zh: z.string().min(1),
    original: z.string().min(1).nullable(),
    en: z.string().min(1).nullable(),
    sourceLabel: z.string().min(1),
    aliases: z.array(z.string().min(1))
  }),
  recommendedWorks: z.array(z.string().min(1)),
  detectiveSlug: z.string().min(1).nullable(),
  releaseDate: z.iso.date().nullable(),
  sourceIds: z.array(z.string().min(1)).min(1),
  sourceUrls: z.array(z.url()).min(1),
  verification: z.object({
    identity: verificationValueSchema,
    recommendedWorks: verificationValueSchema
  })
});

const pictureBookCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotDate: z.iso.date(),
  contentPolicy: z.string().min(1),
  coverage: z.object({
    firstVolume: z.number().int().min(1),
    latestPublishedVolume: z.number().int().min(1),
    standardVolumeCount: z.number().int().min(1),
    entryCount: z.number().int().min(1),
    entriesWithRecommendedWorks: z.number().int().min(0)
  }),
  sources: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      url: z.url(),
      role: z.string().min(1),
      quality: z.enum(["COMMUNITY_INDEX", "COMMUNITY_WIKI", "PUBLISHER"])
    })
  ),
  entries: z.array(pictureBookEntrySchema)
});

export const pictureBookCatalog = pictureBookCatalogSchema.parse(rawCatalog);
export type PictureBookEntry = z.infer<typeof pictureBookEntrySchema>;
