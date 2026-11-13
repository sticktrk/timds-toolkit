// Public configuration. Credentials are read from the Worker's bindings.
export const contact = {
  delivery: "test" as "test" | "production",
  requireConsent: false,
  notification: { from: "", to: "", subject: "Website contact" },
  meta: { pixelId: "", graphVersion: "", testEventCode: "" },
  ga4: { measurementId: "" },
  googleAds: { tagId: "", leadLabel: "" },
  turnstile: { required: false },
};

export const browserTags = () => ({
  pixel: /^\d{5,25}$/.test(contact.meta.pixelId) ? contact.meta.pixelId : "",
  analytics: /^G-[A-Z0-9]+$/.test(contact.ga4.measurementId) ? contact.ga4.measurementId : "",
  ads: /^AW-\d+$/.test(contact.googleAds.tagId) ? contact.googleAds.tagId : "",
  lead: /^[\w-]+$/.test(contact.googleAds.leadLabel) ? contact.googleAds.leadLabel : "",
});

export function consentAllows(value: boolean | undefined, required: boolean) {
  return value === true || (!required && value !== false);
}
