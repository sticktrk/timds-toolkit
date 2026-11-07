// The brand-kit starter's public data contract. The slot vocabulary, stock
// samples, page structure and stock declarations change together in a release.
// This pure module is also copied to scripts/brand-kit.mjs as shared starter
// plumbing, so the viewer has the same defaults before npm dependencies exist.
// It contains no crawling, inference, publishing, or client-specific behavior.
//
// A token slot's sample is the stock parent's own value and mirrors the
// ordinary starter's foundations (templates/tokens.json), so an unfilled kit
// reads like a stock system; its assumption is the rule a builder applies when
// the source shows nothing, which may differ from the sample.

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

export const brandKitLabels = freeze(['confirmed', 'observed', 'assumed', 'unresolved']);
export const brandKitStarter = 'brand-kit';

const slot = (key, kind, source, assumption, guidance, sample, page, label = 'assumed') => ({
  key, group: key.split('.')[0], kind, source, assumption, guidance, sample, page, label,
});
const token = (key, source, assumption, guidance, sample, page) => slot(key, 'token', source, assumption, guidance, sample, page);
const media = (key, source, assumption, guidance, page, sample = '', label = 'assumed') => slot(`media.${key}`, 'media', source, assumption, guidance, sample, page, label);
const element = (key, source, assumption, guidance) => slot(`element.${key}`, 'element', source, assumption, guidance, assumption, 'web/components');
const copy = (key, source, assumption, guidance, sample, page = 'brand/foundation', label = 'assumed') => slot(`copy.${key}`, 'copy', source, assumption, guidance, sample, page, label);

export const brandKitSlots = freeze([
  token('color.canvas', 'Most-used page background.', 'Use a white canvas.', 'Confirm the page ground before choosing any text pair.', '#f5f7fa', 'brand/color'),
  token('color.surface', 'Card and panel backgrounds.', 'Use color.canvas.', 'Pair raised surfaces with color.ink and verify their boundary against the canvas.', '#ffffff', 'brand/color'),
  token('color.ink', 'Body text color.', 'Choose text with contrast on color.canvas.', 'Keep reading text legible on canvas, surface and accent-soft.', '#17202a', 'brand/color'),
  token('color.muted', 'Secondary text color.', 'Mix ink 65% with canvas 35%.', 'Check secondary text on every ground where it appears.', '#5d6876', 'brand/color'),
  token('color.line', 'Borders and rules.', 'Mix ink 18% with canvas 82%.', 'Use this for boundaries, never as the only signal for an action.', '#dce1e8', 'brand/color'),
  token('color.accent', 'Primary button background.', 'Use the most chromatic observed palette color.', 'Reserve the accent for actions and intentional emphasis.', '#2457d6', 'brand/color'),
  token('color.accent-ink', 'Primary button text.', 'Choose light or dark text by contrast on color.accent.', 'Always name this ink when an element uses an accent ground.', '#ffffff', 'brand/color'),
  token('color.accent-soft', 'Hover and selected backgrounds.', 'Mix accent 12% with canvas 88%.', 'Pair this quiet emphasis ground with color.ink.', '#e8efff', 'brand/color'),
  token('color.accent-2', 'A second chromatic color used in links or badges.', 'Use color.accent.', 'Keep a distinct second accent only when the evidence supports it.', '{color.accent}', 'brand/color'),
  token('color.ink-ground', 'The darkest section background, such as a footer.', 'Use color.ink.', 'Use this ground for Bold treatments and the photo scrim.', '{color.ink}', 'brand/color'),
  token('color.ink-ground-text', 'Text on the darkest section background.', 'Use color.surface.', 'Always pair the dark band with its own text token.', '{color.surface}', 'brand/color'),
  token('font.display', 'The family used for h1 through h3.', 'Use font.body.', 'Confirm the heading family and its usable font files before delivery.', 'Georgia, "Times New Roman", serif', 'brand/typography'),
  token('font.body', 'The family used for paragraphs.', 'Use system-ui, sans-serif.', 'Choose a readable body family and retain a reliable fallback.', 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', 'brand/typography'),
  token('font.mono', 'The family used for code.', 'Use ui-monospace, monospace.', 'Use the mono family for values and code rather than running copy.', '"SFMono-Regular", Consolas, "Liberation Mono", monospace', 'brand/typography'),
  token('font.display-weight', 'The h1 font weight.', 'Use 700.', 'Use a weight the display family actually supplies.', '700', 'brand/typography'),
  token('font.body-weight', 'The paragraph font weight.', 'Use 400.', 'Keep reading text at a supported, comfortable weight.', '400', 'brand/typography'),
  ...[
    ['display', '48px', 'Display headlines.'], ['title', '32px', 'Section titles.'],
    ['lead', '20px', 'Introductory copy.'], ['body', '16px', 'Reading text.'],
    ['small', '14px', 'Captions and supporting text.'], ['label', '12px', 'Labels and eyebrows.'],
  ].map(([key, sample, use]) => token(`type.${key}`, 'The observed type scale.', `Use ${sample}.`, `${use} Check hierarchy and wrapping at the smallest intended size.`, sample, 'brand/typography')),
  token('type.display-tracking', 'The h1 letter-spacing.', 'Use 0.', 'Keep headline tracking with the display style, not individual templates.', '0', 'brand/typography'),
  token('type.display-case', 'The h1 text-transform.', 'Use none.', 'Apply case through the heading style; keep stored copy readable.', 'none', 'brand/typography'),
  token('type.display-leading', 'The h1 line-height.', 'Use 1.1.', 'Allow long headlines to wrap without collisions.', '1.1', 'brand/typography'),
  token('type.body-leading', 'The paragraph line-height.', 'Use 1.5.', 'Check reading rhythm with several lines of real copy.', '1.5', 'brand/typography'),
  token('radius.control', 'The primary button radius.', 'Use 8px.', 'Apply one control radius to buttons and fields.', '8px', 'web/spacing'),
  token('radius.card', 'The card radius.', 'Use radius.control.', 'Use the card radius consistently for grouped content.', '14px', 'web/spacing'),
  token('radius.media', 'The image radius.', 'Use radius.card.', 'Keep image corners aligned with their surrounding card.', '{radius.card}', 'web/spacing'),
  token('line.width', 'The button and field border width.', 'Use 1px.', 'Keep border weight consistent across controls and dividers.', '1px', 'web/spacing'),
  token('shadow.card', 'The card box-shadow.', 'Use none.', 'Add elevation only when the source uses it to explain hierarchy.', 'none', 'web/spacing'),
  ...[[1, 4], [2, 8], [3, 12], [4, 16], [6, 24], [8, 32], [12, 48]].map(([key, size]) => token(`space.${key}`, 'The observed spacing distribution.', `Use ${size}px.`, 'Choose spacing from this scale; confirm the rhythm with real content.', `${size}px`, 'web/spacing')),
  token('space.density', 'The median section padding, bucketed as tight, regular or airy.', 'Use regular.', 'Use one density for section rhythm and make deliberate exceptions visible.', 'regular', 'web/spacing'),
  token('motion.fast', 'The button transition duration.', 'Use 150ms.', 'Keep interaction feedback brief and respect reduced-motion preferences.', '150ms', 'web/spacing'),
  media('logo', 'The header mark on a light ground.', 'Set the name in font.display and flag it unresolved.', 'Replace the sample wordmark with an approved mark and confirm its clear space.', 'brand/logo', '', 'unresolved'),
  media('logo-on-dark', 'A mark used on a dark ground, or an approved recolored SVG.', 'Place the on-light mark on a surface plate.', 'Check the mark on the exact dark and accent grounds where it will be used.', 'brand/logo'),
  media('mark', 'A square logo candidate, favicon or touch icon.', 'Set the first letter in font.display on accent.', 'Confirm that the compact mark remains recognizable at small sizes.', 'brand/logo'),
  media('favicon', 'The icon linked by the source page.', 'Use media.mark.', 'Check the icon at browser-tab size and supply a dedicated asset when needed.', 'brand/icons'),
  ...Array.from({length: 6}, (_, index) => media(`photo-${index + 1}`, 'The largest content images, landscape first, with a focal hint.', 'Use no photo; fall back to the Accent or Bold treatment.', 'Start with a center crop, then review subject placement and usage rights before publishing.', 'web/photography')),
  media('illustration', 'Non-photographic raster or SVG artwork.', 'Use no illustration.', 'Keep illustration separate from photography and confirm its intended use.', 'web/photography'),
  media('icon-family', 'The icon set used by the source.', 'Use Font Awesome thin with currentColor.', 'Use one icon family and weight; inherit the surrounding text color.', 'brand/icons', 'Font Awesome thin, currentColor'),
  element('button', 'Primary button padding, radius, border, weight, case and label.', 'Accent flood, 12px by 24px padding, radius.control.', 'Pair the primary action with accent-ink and a short, specific label.'),
  element('button-secondary', 'The secondary button style.', 'Outline in accent on canvas.', 'Keep the secondary action quieter while preserving a visible boundary.'),
  element('link', 'Link color and underline.', 'Accent-2 with an underline.', 'Make links recognizable without depending on color alone.'),
  element('field', 'Input height, border and radius.', '48px height, line.width and radius.control.', 'Keep a visible label, clear focus and an explicit ground/ink pair.'),
  element('card', 'Panel padding, border, radius and shadow.', 'Surface, space.6, radius.card and shadow.card.', 'Group related content with surface and ink, then use spacing before decoration.'),
  element('eyebrow', 'Small uppercase labels above headings.', 'Label size, 0.16em tracking and accent.', 'Keep eyebrows short and verify their color on every treatment.'),
  element('headline', 'The h1 weight, case and tracking.', 'Use the display type slots.', 'Use the same heading style across channels and test the longest headline.'),
  element('emphasis', 'A styled span inside headings.', 'Italic in accent.', 'Emphasize one phrase and retain enough contrast against its ground.'),
  element('rule', 'The divider treatment.', 'A 2px accent rule, 40px wide.', 'Use a rule to separate ideas, without repeating it as decoration.'),
  element('badge', 'A chip or pill.', 'Accent-soft ground and label type.', 'Pair the badge ground with ink and keep its label concise.'),
  element('nav', 'Header height, background and link style.', '64px height, canvas and muted links.', 'Keep navigation legible with visible current and focus states.'),
  element('footer', 'The footer ground and text.', 'Ink-ground with ink-ground-text.', 'Use the named dark-ground pair for every footer element.'),
  element('section', 'Section rhythm and dividers.', 'Space density with line dividers.', 'Keep a consistent vertical rhythm and name the ink whenever the ground changes.'),
  copy('name', 'og:site_name, the title and logo alt text.', 'Use the hostname.', 'Confirm the public-facing brand name before composing.', 'Your brand'),
  copy('tagline', 'The meta description or hero lead.', 'Write what the brand does in one line and flag it unresolved.', 'Replace the neutral line with a specific, supportable description.', 'What your brand does, in one line.', 'brand/foundation', 'unresolved'),
  copy('url', 'The canonical host.', 'Use the hostname.', 'Confirm the public address and show it consistently.', 'Your website'),
  copy('handles', 'Social links in the footer.', 'Leave unfilled when none are observed.', 'Verify each handle before including it in a template.', 'Your social handle'),
  copy('contact', 'Email, telephone and address links.', 'Leave unfilled when none are observed.', 'Confirm contact details and include only what the channel needs.', 'Your contact details'),
  copy('headlines', 'Deduplicated h1 and h2 text.', 'Use three neutral sample headlines.', 'Keep the headline bank specific and check every claim before reuse.', 'Make the next step clear.\nOne useful idea at a time.\nBuilt around what matters.'),
  copy('ctas', 'Button labels.', 'Use Get started and Learn more.', 'Choose one call to action that accurately names the next step.', 'Get started\nLearn more'),
  copy('topics', 'Navigation labels and service names.', 'Use the brand name as an eyebrow when no topics are observed.', 'Keep topic labels short and grounded in the actual offer.', 'Your brand'),
  copy('voice', 'An evidence-based synthesis of the source voice.', 'Use Plain, direct, specific.', 'Treat the sample voice as assumed until an owner reviews examples and evidence.', 'Plain, direct, specific.', 'brand/voice'),
  copy('claims-to-check', 'Superlatives and numerical claims in source copy.', 'Leave unfilled when none are observed.', 'Review evidence for every retained claim before publishing it.', 'Review claims before publication.', 'brand/voice'),
]);

/** Exact token keys: element, media and copy slots are not foundation tokens. */
export const brandKitFoundationTokens = freeze(Object.fromEntries(
  [...new Set(brandKitSlots.filter(entry => entry.kind === 'token').map(entry => entry.group))].map(group => [group,
    Object.fromEntries(brandKitSlots.filter(entry => entry.kind === 'token' && entry.group === group).map(entry => [entry.key.slice(group.length + 1), {value: entry.sample, label: entry.label, description: entry.guidance}]))
  ]),
));
export const brandKitCopySamples = freeze(Object.fromEntries(brandKitSlots.filter(entry => entry.kind === 'copy').map(entry => [entry.key.slice(5), entry.sample])));
export const brandKitMediaSamples = freeze(Object.fromEntries(brandKitSlots.filter(entry => entry.kind === 'media').map(entry => [entry.key.slice(6), entry.sample])));

const page = (slug, title, summary, planned = false) => ({slug, title, summary, ...(planned ? {planned: true} : {})});
const planned = (slug, title, summary) => page(slug, title, summary, true);
export const brandKitViews = freeze([
  {id: 'brand', label: 'Brand', blurb: 'The foundations', pages: [
    page('foundation', 'Foundation', 'The brand name, purpose, source evidence and assumptions.'),
    page('logo', 'Logo', 'Marks, their grounds and what still needs approval.'),
    page('color', 'Color', 'Palette slots and the ink paired with every ground.'),
    page('typography', 'Typography', 'Font families, weights, scale and heading behavior.'),
    page('icons', 'Icons', 'The compact mark, favicon and icon family.'),
    page('voice', 'Voice & Tone', 'The sample voice, copy bank and claims to review.'),
    page('evidence', 'Evidence', 'Captured observations, sources and unresolved decisions.'),
  ]},
  {id: 'web', label: 'Web', blurb: 'Components and pages', pages: [
    page('components', 'Components', 'The elements every template and whole page uses.'),
    page('spacing', 'Spacing & shape', 'Spacing, density, corners, borders, shadows and motion.'),
    page('layout', 'Layout', 'A live launch-page demonstration on the shared components.'),
    page('photography', 'Photography', 'The six photo slots, illustration and crop guidance.'),
    planned('page-archetypes', 'Page archetypes', 'Whole-page patterns to author for this system.'),
    planned('email', 'Email principles', 'Inbox constraints and component translation.'),
    planned('email-templates', 'Email templates', 'Reusable whole-message patterns.'),
  ]},
  {id: 'social', label: 'Social', blurb: 'Posts and stories', pages: [
    page('', 'Overview', 'Treatments, the social format catalog and how previews are built.'),
    page('posts', 'Posts', 'Square, portrait and story templates in four treatments.'),
    page('carousel', 'Carousel', 'Cover, point and closing frames on one consistent grid.'),
    planned('foundations', 'Brand on social', 'How the brand behaves in a mobile feed.'),
    planned('linkedin', 'LinkedIn specs', 'Platform facts to confirm before use.'),
    planned('linkedin-templates', 'LinkedIn templates', 'Additional post and document patterns.'),
    planned('video', 'Video', 'Motion patterns and production guidance.'),
    planned('shorts', 'Shorts', 'Vertical motion with safe areas and captions.'),
    planned('content', 'Pillars & cadence', 'Topics and a sustainable publishing rhythm.'),
  ]},
  {id: 'ads', label: 'Ads', blurb: 'Paid placements', pages: [
    page('', 'Overview', 'Treatments, the ad format catalog and delivery checks.'),
    page('paid-social', 'Meta and LinkedIn', 'Feed, portrait and sponsored-content templates.'),
    page('display', 'Google display', 'The core display set in four treatments.'),
    planned('responsive', 'Responsive & PMax', 'Responsive assets and text limits to confirm.'),
    planned('business-profile', 'Business profile', 'Profile updates and supported actions.'),
    planned('compliance', 'Compliance', 'Applicable claims and accessibility checks.'),
  ]},
  {id: 'email', label: 'Email', blurb: 'One clear message', pages: [
    page('', 'Overview', 'Treatments, the email format catalog and delivery checks.'),
    page('banners', 'Header and signature', 'Campaign headers and signature banners.'),
    page('message', 'One message', 'A single-message layout on the system.'),
    planned('principles', 'Email principles', 'Rendering constraints and accessible fallbacks.'),
    planned('templates', 'Templates', 'Additional message patterns authored for this brand.'),
  ]},
  {id: 'print', label: 'Print', blurb: 'Paper and display', pages: [
    page('', 'Overview', 'Treatments, the print format catalog and printer handoff.'),
    page('sheet', 'One-page sheet', 'A compact letter-size information sheet.'),
    page('poster', 'Flyer and poster', 'Two scales for a single, clear message.'),
    page('business-card', 'Business card', 'A compact identity and contact frame.'),
    planned('letterheads', 'Letterheads', 'Correspondence and document grids.'),
    planned('brochures', 'Brochures', 'Folded collateral and panel order.'),
    planned('booklets', 'Booklets', 'Cover and interior page systems.'),
    planned('notepads', 'Notepads', 'Writable sheets and repeatable rules.'),
    planned('banners', 'Banners', 'Large-format messages read at distance.'),
  ]},
  {id: 'events', label: 'Events', blurb: 'Gather and welcome', pages: [
    page('', 'Overview', 'Treatments, event formats and attendee-facing checks.'),
    page('poster', 'Event poster', 'A poster led by one event message.'),
    page('social', 'Event post and story', 'Event announcements in feed and story formats.'),
    page('badge', 'Name badge', 'A readable attendee name and compact identity.'),
    planned('webinar-banners', 'Webinar banners', 'Registration and broadcast graphics.'),
    planned('virtual-backgrounds', 'Virtual backgrounds', 'Speaker-safe call backgrounds.'),
    planned('covers', 'Eventbrite and Facebook covers', 'Event covers sized for their destination.'),
  ]},
  {id: 'decks', label: 'Decks', blurb: 'Present an idea', pages: [
    page('', 'Overview', 'Treatments, slide formats and a repeatable deck grid.'),
    page('slides', 'Slides', 'Title, section, content and closing slide templates.'),
    planned('templates', 'Presentation templates', 'Whole-deck structures for recurring needs.'),
    planned('webinar-titles', 'Webinar title slides', 'Opening frames for live presentations.'),
  ]},
  {id: 'use', label: 'Use', blurb: 'Make and connect', pages: [
    {...page('', 'Landing', 'Explore the kit, choose a format and start making on brand.'), layout: 'landing'},
    {...page('compose', 'Compose', 'Make an asset from any channel in the kit’s format catalog and a brief.'), promote: 'Start making'},
    page('install', 'Install', 'Connect tools and author whole pages with a designer’s agent.'),
  ]},
]);

const pageId = (view, entry) => entry.slug ? `${view.id}/${entry.slug}` : view.id;
export const brandKitPages = freeze({
  authored: ['index', ...brandKitViews.flatMap(view => view.pages.filter(entry => !entry.planned).map(entry => pageId(view, entry)))],
  planned: brandKitViews.flatMap(view => view.pages.filter(entry => entry.planned).map(entry => pageId(view, entry))),
  builderOwned: ['brand/evidence'],
});
export const brandKitStockPaths = freeze([
  'src/layout.html', 'src/styles/system.css', 'src/copy.json',
  ...brandKitPages.authored.filter(id => !brandKitPages.builderOwned.includes(id)).map(id => `src/pages/${id === 'index' ? 'index' : id.includes('/') ? id : `${id}/index`}.html`),
]);
export const brandKitTreatments = freeze([
  {id: 'minimal', label: 'Minimal', ground: 'color.canvas', ink: 'color.ink', mark: 'media.logo', accent: 'color.accent'},
  {id: 'accent', label: 'Accent', ground: 'color.accent', ink: 'color.accent-ink', mark: 'media.logo or media.logo-on-dark by contrast', accent: 'color.accent-soft'},
  {id: 'bold', label: 'Bold', ground: 'color.ink-ground', ink: 'color.ink-ground-text', mark: 'media.logo-on-dark', accent: 'color.accent'},
  {id: 'photo', label: 'Photo', ground: 'color.ink-ground', ink: 'color.ink-ground-text', mark: 'media.logo-on-dark', accent: 'color.accent', photo: 'media.photo-1'},
]);
