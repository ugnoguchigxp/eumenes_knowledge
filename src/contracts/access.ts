import { z } from "zod";

/**
 * Who is reading, bound by the host from its own authentication (p0.md §4). A request body, a tool
 * input or a query string never supplies it. `namespaces` are the Docling namespaces this
 * principal may read; anything outside them answers as not available.
 */
export const accessContextSchema = z.strictObject({
	principal: z.string().min(1).max(200),
	namespaces: z.array(z.string().min(1).max(512)).max(1000),
});
export type AccessContext = z.infer<typeof accessContextSchema>;
