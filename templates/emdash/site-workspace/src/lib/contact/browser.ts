import { consentAllows } from "./config";

type Consent = { analytics?: boolean; marketing?: boolean };
type Tags = { pixel: string; analytics: string; ads: string; lead: string };
type TagWindow = Window & {
  timdsConsent?: Consent;
  dataLayer?: unknown[];
  fbq?: Pixel;
  _fbq?: Pixel;
};
type Pixel = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push?: Pixel;
  loaded?: boolean;
  version?: string;
};

const tagWindow: TagWindow = window;
const node = document.querySelector<HTMLElement>("[data-timds-tracking]");
const tags: Tags | null = JSON.parse(node?.dataset.timdsTracking ?? "null");
const requireConsent = node?.dataset.timdsConsentRequired === "true";
const enabled = new Set<string>();
const queued = new WeakSet<HTMLFormElement>();
const requests = new WeakMap<HTMLFormElement, { id: string; signature: string; consent: Consent }>();
const converted = new Set<string>();
const consent = () => ({
  analytics: consentAllows(tagWindow.timdsConsent?.analytics, requireConsent),
  marketing: consentAllows(tagWindow.timdsConsent?.marketing, requireConsent),
});

function load(url: string) {
  const script = document.createElement("script");
  script.async = true;
  script.src = url;
  document.head.append(script);
}

function google(..._args: unknown[]) {
  // Google reads the arguments object in dataLayer.
  (tagWindow.dataLayer ??= []).push(arguments);
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
    const pixel: Pixel = Object.assign((...args: unknown[]) => {
      if (pixel.callMethod) pixel.callMethod(...args);
      else pixel.queue.push(args);
    }, { queue: [] as unknown[][], loaded: true, version: "2.0" });
    pixel.push = pixel;
    tagWindow.fbq = tagWindow._fbq = pixel;
    enabled.add("pixel");
    pixel("init", tags.pixel);
    pixel("trackSingle", tags.pixel, "PageView");
    load("https://connect.facebook.net/en_US/fbevents.js");
  }
  if (enabled.has("pixel")) tagWindow.fbq?.("consent", allowed.marketing ? "grant" : "revoke");
}

function conversions(receipt: { receipt: string; analytics: boolean; marketing: boolean }) {
  if (!tags || converted.has(receipt.receipt)) return;
  // Keep duplicate conversion suppression through a refresh in the same tab.
  try {
    const key = "timds:contact-conversions";
    const recent: string[] = JSON.parse(sessionStorage.getItem(key) ?? "[]");
    if (recent.includes(receipt.receipt)) return;
    sessionStorage.setItem(key, JSON.stringify([...recent.slice(-49), receipt.receipt]));
  } catch {}
  converted.add(receipt.receipt);
  const allowed = consent();
  if (allowed.analytics && receipt.analytics && enabled.has(tags.analytics)) {
    google("event", "generate_lead", { send_to: tags.analytics });
  }
  if (allowed.marketing && receipt.marketing) {
    if (enabled.has("pixel")) tagWindow.fbq?.("trackSingle", tags.pixel, "Lead", {}, { eventID: receipt.receipt });
    if (enabled.has(tags.ads) && tags.lead) {
      google("event", "conversion", { send_to: `${tags.ads}/${tags.lead}`, transaction_id: receipt.receipt });
    }
  }
}

async function submit(form: HTMLFormElement, target: URL) {
  const fields = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value === "string") fields.append(name, value);
  }
  const signature = JSON.stringify([...fields].filter(([name]) => !["cf-turnstile-response", "submission_id", "analytics_consent", "marketing_consent"].includes(name)));
  const previous = requests.get(form);
  const choices = tagWindow.timdsConsent;
  const pending = previous?.signature === signature ? previous : {
    id: crypto.randomUUID(), signature, consent: { analytics: choices?.analytics, marketing: choices?.marketing },
  };
  requests.set(form, pending);
  for (const category of ["analytics", "marketing"] as const) {
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
    const status = form.querySelector<HTMLElement>("[data-timds-contact-status]");
    if (status) status.textContent = (success ? form.dataset.timdsContactSuccess : form.dataset.timdsContactError) ?? "";
    form.dispatchEvent(new CustomEvent("timds:contact-result", { bubbles: true, detail: { ok: success } }));
  }
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-timds-contact") || form.method !== "post") return;
  if (event.defaultPrevented) return;
  const submitter = (event as SubmitEvent).submitter;
  if (submitter?.hasAttribute("formmethod") || submitter?.hasAttribute("formaction")) return;
  const target = new URL(form.action);
  if (target.origin !== location.origin) return;
  event.preventDefault();
  if (!queued.has(form)) void submit(form, target);
});
window.addEventListener("timds:consent", configure);
configure();
