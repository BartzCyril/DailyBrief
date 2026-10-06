import { z } from "zod";
const selector = z.string().trim().min(1).max(200);
export const scrapingSchema = z
  .object({
    articleSelector: selector,
    titleSelector: selector,
    linkSelector: selector,
    descriptionSelector: selector.nullish(),
    dateSelector: selector.nullish(),
    mode: z.enum(["SCROLL", "PAGINATE"]),
    scroll: z
      .object({
        maxScrolls: z.number().int().min(0).max(8),
        waitAfterScrollMs: z.number().int().min(100).max(3000),
      })
      .strict()
      .optional(),
    pagination: z
      .object({
        strategy: z.enum(["URL_TEMPLATE", "QUERY_PARAM"]),
        maxPages: z.number().int().min(1).max(5),
        startPage: z.number().int().min(1).max(1000).default(1),
        urlTemplate: z.string().max(2000).optional(),
        queryParam: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "SCROLL" && !value.scroll)
      context.addIssue({
        code: "custom",
        path: ["scroll"],
        message: "Paramètres de scroll requis",
      });
    if (value.mode === "PAGINATE") {
      if (!value.pagination) {
        context.addIssue({
          code: "custom",
          path: ["pagination"],
          message: "Paramètres de pagination requis",
        });
        return;
      }
      if (
        value.pagination.strategy === "URL_TEMPLATE" &&
        !value.pagination.urlTemplate?.includes("{page}")
      )
        context.addIssue({
          code: "custom",
          path: ["pagination", "urlTemplate"],
          message: "Le modèle doit contenir {page}",
        });
      if (value.pagination.strategy === "QUERY_PARAM" && !value.pagination.queryParam)
        context.addIssue({
          code: "custom",
          path: ["pagination", "queryParam"],
          message: "Paramètre requis",
        });
    }
  });
