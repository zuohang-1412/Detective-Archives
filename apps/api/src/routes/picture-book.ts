import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pictureBookCatalog } from "../data/picture-book.js";

const listQuerySchema = z
  .object({
    q: z.string().trim().max(50).optional(),
    fromVolume: z.coerce.number().int().min(1).max(108).default(1),
    toVolume: z.coerce.number().int().min(1).max(108).default(108),
    edition: z.enum(["STANDARD", "SPECIAL"]).optional(),
    identityStatus: z.enum(["SOURCE_CAPTURED", "PRIMARY_SOURCE_CONFIRMED"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(150).default(30)
  })
  .refine((query) => query.fromVolume <= query.toVolume, {
    message: "fromVolume must be less than or equal to toVolume",
    path: ["fromVolume"]
  });

const idParamsSchema = z.object({
  id: z.string().trim().regex(/^PB-\d{3}-(STD|SP)$/i)
});

export const pictureBookRoutes: FastifyPluginAsync = async (app) => {
  app.get("/picture-book", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_QUERY",
        message: "图鉴查询条件不合法",
        details: parsed.error.flatten()
      });
    }

    const {
      q,
      fromVolume,
      toVolume,
      edition,
      identityStatus,
      page,
      pageSize
    } = parsed.data;
    const normalizedQuery = q?.toLocaleLowerCase("zh-CN");
    const filtered = pictureBookCatalog.entries.filter((entry) => {
      const searchable = [
        entry.id,
        entry.names.zh,
        entry.names.original,
        entry.names.en,
        ...entry.names.aliases,
        ...entry.recommendedWorks
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLocaleLowerCase("zh-CN");

      return entry.volumeNo >= fromVolume
        && entry.volumeNo <= toVolume
        && (!edition || entry.edition === edition)
        && (!identityStatus || entry.verification.identity === identityStatus)
        && (!normalizedQuery || searchable.includes(normalizedQuery));
    });

    const start = (page - 1) * pageSize;
    return {
      data: filtered.slice(start, start + pageSize),
      coverage: pictureBookCatalog.coverage,
      snapshotDate: pictureBookCatalog.snapshotDate,
      pagination: {
        page,
        pageSize,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / pageSize)
      }
    };
  });

  app.get("/picture-book/:id", async (request, reply) => {
    const parsed = idParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_ENTRY_ID", message: "图鉴编号不合法" });
    }

    const entry = pictureBookCatalog.entries.find(
      (item) => item.id === parsed.data.id.toUpperCase()
    );
    if (!entry) {
      return reply.code(404).send({ code: "PICTURE_BOOK_ENTRY_NOT_FOUND", message: "未找到该图鉴条目" });
    }

    return { data: entry };
  });
};
