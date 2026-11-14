import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { defineMiddleware } from "astro:middleware";

import Gone from "./components/Gone.astro";

export const onRequest = defineMiddleware(async (context, next) => {
	const response = await next();
	if (context.request.method !== "GET" || response.status !== 410 || response.body !== null || response.headers.has("Content-Type")) return response;
	try {
		const container = await AstroContainer.create();
		const design = await container.renderToResponse(Gone, { partial: false, request: context.request, locals: context.locals });
		const headers = new Headers(response.headers);
		headers.delete("Content-Length");
		headers.set("Content-Type", "text/html; charset=utf-8");
		return new Response(design.body, { status: response.status, statusText: response.statusText, headers });
	} catch (caught) {
		console.error("Unable to render the designed Gone response", caught);
		return response;
	}
});
