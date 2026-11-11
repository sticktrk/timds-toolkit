// The form dispatch the design system integration's middleware runs
// (forms-middleware.mjs): a POST to an address that has a form handler under
// src/forms/ goes to that handler before Astro picks a page, so a page the
// site has at the same address (the article list at /articles) never answers
// it. A handler whose POST is not a function answers 405 and the server log
// names its module; every other request goes on to the site's routes. Kept
// apart from the middleware so it runs in plain Node, with no virtual module.

/**
 * The route a request path names for the form handlers: `base` taken off
 * when the path has it, no trailing slash ("/" for the root). Astro's
 * development server routes a path with and without the base to the same
 * page, so both name the same handler.
 */
export function formRoute(pathname, base = "/") {
  const prefix = String(base || "/").replace(/\/+$/, "");
  let route = pathname;
  if (prefix && (route === prefix || route.startsWith(`${prefix}/`))) route = route.slice(prefix.length);
  return route.replace(/\/+$/, "") || "/";
}

/** The middleware for the handlers in `forms` (the virtual module's export) under `base`. */
export function formDispatch(forms, base = "/") {
  return async (context, next) => {
    if (context.request.method !== "POST") return next();
    const route = formRoute(context.url.pathname, base);
    const entry = Object.hasOwn(forms, route) ? forms[route] : undefined;
    if (!entry) return next();
    const { POST } = await entry.load();
    if (typeof POST === "function") return POST(context);
    console.error(`${entry.file} handles the forms that post to ${route}, but its POST export is not a function (it is ${POST === null ? "null" : typeof POST}), so a POST there answers 405. Export POST as a function.`);
    return new Response("POST is not accepted at this address.", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  };
}
