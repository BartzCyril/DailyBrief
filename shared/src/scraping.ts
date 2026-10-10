import { z } from "zod";
const selector = z.string().trim().min(1).max(200);
export const scrapingSchema = z
  .object({
    articleSelector: selector,
    titleSelector: selector,
    linkSelector: selector,
    descriptionSelector: selector.nullish(),
    dateSelector: selector.nullish(),
    mode: z.enum(["SCROLL", "PAGINATE", "LOAD_MORE"]),
    loadMore: z
      .object({
        buttonSelector: selector,
        waitTimeoutMs: z.number().int().min(1000).max(60000),
      })
      .strict()
      .optional(),
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
        // Accept saved configurations from older versions, but discard their cap.
        maxPages: z.unknown().optional(),
        startPage: z.number().int().min(0).default(1),
        urlTemplate: z.string().max(2000).optional(),
        queryParam: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/)
          .optional(),
      })
      .strict()
      .transform(({ maxPages: _legacyMaxPages, ...pagination }) => pagination)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "LOAD_MORE" && !value.loadMore)
      context.addIssue({
        code: "custom",
        path: ["loadMore"],
        message: "Paramètres du bouton requis",
      });
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

// Reading saved sources remains compatible with configurations created before
// description and date became mandatory. New and edited configurations are strict.
export const scrapingInputSchema = scrapingSchema.safeExtend({
  descriptionSelector: selector,
  dateSelector: selector,
});
