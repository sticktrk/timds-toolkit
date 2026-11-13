let tags = null;
let requireConsent = true;
const enabled = new Set();
const queued = new WeakSet();
const requests = new WeakMap();
const converted = new Set();
const submissionFields = new Set(["cf-turnstile-response", "submission_id", "analytics_consent", "marketing_consent"]);
// The module is served from the site root at either deployment base.
const base = new URL(".", import.meta.url).pathname.replace(/\/+$/, "");
const consentAllows = (value) => value === true || (!requireConsent && value !== false);
const consent = () => ({
  analytics: consentAllows(window.timdsConsent?.analytics),
  marketing: consentAllows(window.timdsConsent?.marketing),
});

function load(url) {
  const script = document.createElement("script");
  script.async = true;
  script.src = url;
  document.head.append(script);
}

function google() {
  (window.dataLayer ??= []).push(arguments);
}

function configure() {
  if (!tags) return;
  const allowed = consent();
  const analytics = allowed.analytics && tags.analytics;
  const ads = allowed.marketing && tags.ads;
  if (enabled.has("google") || analytics || ads) {
    google("consent", enabled.has("google") ? "update" : "default", {
      analytics_storage: allowed.analytics ? "granted" : "denied",
      ad_storage: allowed.marketing ? "granted" : "denied",
      ad_user_data: allowed.marketing ? "granted" : "denied",
      ad_personalization: allowed.marketing ? "granted" : "denied",
    });
  }
  if (!enabled.has("google") && (analytics || ads)) {
    enabled.add("google");
    google("js", new Date());
    load(`https://www.googletagmanager.com/gtag/js?id=${analytics || ads}`);
  }
  for (const id of [analytics, ads]) {
    if (id && !enabled.has(id)) {
      enabled.add(id);
      google("config", id, { send_page_view: false });
      if (id === analytics) google("event", "page_view", { send_to: id });
    }
  }
  if (tags.pixel && allowed.marketing && !enabled.has("pixel")) {
    const pixel = Object.assign((...args) => {
      if (pixel.callMethod) pixel.callMethod(...args);
      else pixel.queue.push(args);
    }, { queue: [], loaded: true, version: "2.0" });
    pixel.push = pixel;
    window.fbq = window._fbq = pixel;
    enabled.add("pixel");
    pixel("init", tags.pixel);
    pixel("trackSingle", tags.pixel, "PageView");
    load("https://connect.facebook.net/en_US/fbevents.js");
  }
  if (enabled.has("pixel")) window.fbq?.("consent", allowed.marketing ? "grant" : "revoke");
}

function conversions(receipt) {
  if (!tags || converted.has(receipt.receipt)) return;
  // Keep duplicate conversion suppression through a refresh in the same tab.
  try {
    const key = "timds:contact-conversions";
    const recent = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    if (recent.includes(receipt.receipt)) return;
    sessionStorage.setItem(key, JSON.stringify([...recent.slice(-49), receipt.receipt]));
  } catch {}
  converted.add(receipt.receipt);
  const allowed = consent();
  if (allowed.analytics && receipt.analytics && enabled.has(tags.analytics)) {
    google("event", "generate_lead", { send_to: tags.analytics });
  }
  if (allowed.marketing && receipt.marketing) {
    if (enabled.has("pixel")) window.fbq?.("trackSingle", tags.pixel, "Lead", {}, { eventID: receipt.receipt });
    if (enabled.has(tags.ads) && tags.lead) {
      google("event", "conversion", { send_to: `${tags.ads}/${tags.lead}`, transaction_id: receipt.receipt });
    }
  }
}

async function submit(form, target, submitter) {
  const fields = new URLSearchParams();
  for (const [name, value] of new FormData(form, submitter)) {
    if (typeof value === "string") fields.append(name, value);
  }
  const signature = JSON.stringify([target.href, [...fields].filter(([name]) => !submissionFields.has(name))]);
  const previous = requests.get(form);
  const choices = window.timdsConsent;
  const pending = previous?.signature === signature ? previous : {
    id: crypto.randomUUID(), signature, consent: { analytics: choices?.analytics, marketing: choices?.marketing },
  };
  requests.set(form, pending);
  for (const category of ["analytics", "marketing"]) {
    const field = `${category}_consent`;
    const choice = pending.consent[category];
    if (typeof choice === "boolean") fields.set(field, choice ? "yes" : "no");
    else fields.delete(field);
  }
  fields.set("submission_id", pending.id);
  queued.add(form);
  form.setAttribute("aria-busy", "true");
  let success = false;
  try {
    const result = await fetch(target, { method: "POST", body: fields, redirect: "error" });
    const receipt = await result.json();
    if (!result.ok || typeof receipt.receipt !== "string") {
      if ([400, 403, 409].includes(result.status)) requests.delete(form);
      throw new Error("Contact submission failed");
    }
    success = true;
    form.reset();
    requests.delete(form);
    configure();
    conversions(receipt);
  } catch {
    // The same form values retry with the same key if the response was lost.
  } finally {
    queued.delete(form);
    form.removeAttribute("aria-busy");
    const status = form.querySelector("[data-timds-contact-status]");
    if (status) status.textContent = (success ? form.dataset.timdsContactSuccess : form.dataset.timdsContactError) ?? "";
    form.dispatchEvent(new CustomEvent("timds:contact-result", { bubbles: true, detail: { ok: success } }));
  }
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (event.defaultPrevented || !(form instanceof HTMLFormElement)
    || !form.hasAttribute("data-timds-contact") || form.dataset.timdsForm === "not-connected") return;

  const submitter = event.submitter;
  const method = submitter?.hasAttribute("formmethod") ? submitter.formMethod : form.method;
  if (method !== "post") return;
  const action = (submitter?.getAttribute("formaction") ?? form.getAttribute("action"))?.trim();
  let target;
  try { target = new URL(action || location.href, document.baseURI); }
  catch { return; }
  if (target.origin !== location.origin) return;
  if (base && action?.startsWith("/") && !action.startsWith("//")
    && target.pathname !== base && !target.pathname.startsWith(`${base}/`)) {
    target.pathname = base + target.pathname;
  }
  target.hash = "";
  event.preventDefault();
  if (!queued.has(form)) void submit(form, target, submitter);
});
function readTracking() {
  const node = document.querySelector("[data-timds-tracking]");
  tags = JSON.parse(node?.dataset.timdsTracking ?? "null");
  requireConsent = node?.dataset.timdsConsentRequired !== "false";
  configure();
}

window.addEventListener("timds:consent", configure);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", readTracking, { once: true });
else readTracking();
