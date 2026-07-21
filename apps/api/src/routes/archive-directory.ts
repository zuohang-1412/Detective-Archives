import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { archiveDirectory } from "../data/archive-directory.js";

const listQuerySchema = z.object({
  q: z.string().trim().max(50).optional(),
  collection: z.enum(["ARCHIVE_EXTENSION", "HISTORICAL_CASES"]).optional(),
  category: z
    .enum([
      "WORLD_LITERATURE",
      "SCREEN_DETECTIVES",
      "JAPANESE_POPULAR",
      "CHINESE_LITERATURE",
      "HISTORICAL_JUSTICE"
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20)
});

const idParamsSchema = z.object({
  id: z.string().trim().regex(/^(EXT|HIS)-(WL|SC|JP|CN)-\d{3}$/i)
});

export const archiveDirectoryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/archive-directory", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_QUERY",
        message: "扩展目录查询条件不合法",
        details: parsed.error.flatten()
      });
    }

    const { q, collection, category, page, pageSize } = parsed.data;
    const normalizedQuery = q?.toLocaleLowerCase("zh-CN");
    const filtered = archiveDirectory.entries.filter((entry) => {
      const searchable = [
        entry.id,
        entry.names.zh,
        entry.names.original,
        entry.names.en,
        ...entry.names.aliases,
        entry.region,
        entry.creatorName,
        ...entry.featuredWorks,
        ...entry.tags
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLocaleLowerCase("zh-CN");

      return (!collection || entry.collection === collection)
        && (!category || entry.category === category)
        && (!normalizedQuery || searchable.includes(normalizedQuery));
    });

    const start = (page - 1) * pageSize;
    return {
      data: filtered.slice(start, start + pageSize),
      coverage: archiveDirectory.coverage,
      snapshotDate: archiveDirectory.snapshotDate,
      pagination: {
        page,
        pageSize,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / pageSize)
      }
    };
  });

  app.get("/archive-directory/:id", async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_DIRECTORY_ENTRY_ID",
        message: "扩展目录编号不合法"
      });
    }

    const entry = archiveDirectory.entries.find(
      (item) => item.id === parsed.data.id.toUpperCase()
    );
    if (!entry) {
      return reply.code(404).send({
        code: "DIRECTORY_ENTRY_NOT_FOUND",
        message: "未找到该扩展目录条目"
      });
    }

    const sources = archiveDirectory.sources.filter((source) =>
      entry.sourceIds.includes(source.id)
    );
    return { data: entry, sources };
  });
};
