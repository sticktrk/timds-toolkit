// The middleware the design system integration registers: the site's form
// handlers answer a POST to their address before any page does
// (form-dispatch.mjs has the rule).
import { forms } from "virtual:timds/design-system";

import { formDispatch } from "./form-dispatch.mjs";

export const onRequest = formDispatch(forms, import.meta.env.BASE_URL);
