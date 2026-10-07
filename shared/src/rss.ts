import { z } from "zod";

// Empty fields are omitted by the UI; null explicitly disables notice-link following.
export const articleLinkSelectorSchema = z.string().trim().min(1).max(200).nullish();
