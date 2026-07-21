import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { DatabaseClient } from "../db/types.js";
import { getArchiveEntry, listArchiveEntries } from "../repositories/archive-directory.js";

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

interface ArchiveDirectoryRouteOptions {
  database?: DatabaseClient;
}

export const archiveDirectoryRoutes: FastifyPluginAsync<ArchiveDirectoryRouteOptions> = async (
  app,
  options
) => {
  app.get("/archive-directory", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_QUERY",
        message: "扩展目录查询条件不合法",
        details: parsed.error.flatten()
      });
    }

    const { page, pageSize } = parsed.data;
    const result = await listArchiveEntries(options.database, parsed.data);
    return {
      data: result.data,
      coverage: result.coverage,
      snapshotDate: result.snapshotDate,
      pagination: {
        page,
        pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / pageSize)
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

    const result = await getArchiveEntry(options.database, parsed.data.id.toUpperCase());
    if (!result) {
      return reply.code(404).send({
        code: "DIRECTORY_ENTRY_NOT_FOUND",
        message: "未找到该扩展目录条目"
      });
    }

    return result;
  });
};
