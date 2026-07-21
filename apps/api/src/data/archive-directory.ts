import { z } from "zod";
import rawDirectory from "./archive-directory-index.json" with { type: "json" };

const sourceQualitySchema = z.enum([
  "PUBLISHER",
  "OFFICIAL_CREATOR",
  "OFFICIAL_PLATFORM",
  "ACADEMIC_PUBLISHER",
  "LIBRARY",
  "PUBLIC_INSTITUTION"
]);

const mediaTypeSchema = z.enum([
  "NOVEL",
  "SHORT_STORY",
  "COMIC",
  "ANIMATION",
  "FILM",
  "SERIES",
  "OPERA",
  "HISTORY",
  "FORENSICS"
]);

const archiveDirectoryEntrySchema = z.object({
  id: z.string().regex(/^(EXT|HIS)-(WL|SC|JP|CN)-\d{3}$/),
  collection: z.enum(["ARCHIVE_EXTENSION", "HISTORICAL_CASES"]),
  category: z.enum([
    "WORLD_LITERATURE",
    "SCREEN_DETECTIVES",
    "JAPANESE_POPULAR",
    "CHINESE_LITERATURE",
    "HISTORICAL_JUSTICE"
  ]),
  names: z.object({
    zh: z.string().min(1),
    original: z.string().min(1),
    en: z.string().min(1).nullable(),
    aliases: z.array(z.string().min(1))
  }),
  region: z.string().min(1),
  creatorName: z.string().min(1).nullable(),
  mediaTypes: z.array(mediaTypeSchema).min(1),
  summary: z.string().min(1).max(160),
  featuredWorks: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string().min(1)).min(1),
  sourceIds: z.array(z.string().min(1)).min(1),
  verification: z.enum(["SOURCE_CAPTURED", "AUTHORITATIVE_SOURCE_CONFIRMED"])
});

const archiveDirectorySchema = z.object({
  schemaVersion: z.literal(1),
  snapshotDate: z.iso.date(),
  contentPolicy: z.string().min(1),
  coverage: z.object({
    extensionCount: z.number().int().min(0),
    historicalCount: z.number().int().min(0),
    entryCount: z.number().int().min(1)
  }),
  sources: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      url: z.url(),
      quality: sourceQualitySchema
    })
  ),
  entries: z.array(archiveDirectoryEntrySchema)
});

export const archiveDirectory = archiveDirectorySchema.parse(rawDirectory);
export type ArchiveDirectoryEntry = z.infer<typeof archiveDirectoryEntrySchema>;
