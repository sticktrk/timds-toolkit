// The middleware the design system integration registers: the site's form
// handlers answer a POST to their address before any page does
// (form-dispatch.mjs has the rule).
import { forms, routeError } from "virtual:timds/design-system";

import { formDispatch } from "./form-dispatch.mjs";

const dispatch = formDispatch(forms, import.meta.env.BASE_URL);
export const onRequest = (context, next) => dispatch(context, () => routeError
  ? new Response("Site route configuration needs correction.", { status: 503, headers: { "Cache-Control": "no-store" } })
  : next());
