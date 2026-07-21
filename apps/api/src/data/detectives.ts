import { z } from "zod";
import type { Detective } from "../types.js";
import rawDetectives from "./core-detectives.json" with { type: "json" };

const workSummarySchema = z.object({
  id: z.string().min(1),
  titleZh: z.string().min(1),
  titleOriginal: z.string().min(1),
  type: z.enum(["NOVEL", "SHORT_STORY", "FILM", "SERIES"]),
  releaseYear: z.number().int().min(1000).max(2200),
  creatorName: z.string().min(1)
});

const detectiveSchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  nameZh: z.string().min(1),
  nameOriginal: z.string().min(1),
  country: z.string().min(1),
  creatorName: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1),
  works: z.array(workSummarySchema).min(1)
});

export const detectives: Detective[] = z.array(detectiveSchema).parse(rawDetectives);
