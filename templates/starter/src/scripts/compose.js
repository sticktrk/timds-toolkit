// The composer on the Use page: presets, a chat, and a preview, against the
// host's compose route. The page carries no credential and names no provider;
// the model, the image generation, the per-system allowance, and the human
// check all live in the host, and this script only talks to its route,
// relative to the published root the app bar's brand link names.
//
//   GET  <root>compose  → { enabled, allowance: { remaining, total, period },
//                           challenge: { siteKey } | null,
//                           contact: { label, href } | null }
//        Anything but a 200 with enabled true is the off state.
//   POST <root>compose  → text/event-stream, one JSON object per event:
//        conversation { token }      the visit's conversation, sent back on every later message
//        text         { delta }      the reply, streamed
//        caption      { text }       the caption to paste
//        image        { url, download?, type? }   the finished image
//        allowance    { remaining, total, period }
//        error        { code: off | exhausted | challenge | failed, message, action?: { label, href } }
//        done         {}
//
// Without the script the presets still show what the system makes; nothing a
// page says depends on it.
(() => {
  const app = document.querySelector("[data-compose]");
  if (!app || !("fetch" in window)) return;

  const brand = document.querySelector(".appbar__brand");
  const root = new URL(brand ? brand.getAttribute("href") : "/", location.href);
  const route = new URL("compose", root);
  const name = app.dataset.name || "Brand";
  const $ = (selector) => app.querySelector(selector);
  const presets = [...app.querySelectorAll("input[name=preset]")];
  // ?format=ID, as the front page's cards link here, opens the composer on
  // that preset and brings its tab forward; an id the catalog lacks is ignored.
  const wanted = presets.find((preset) => preset.value === new URLSearchParams(location.search).get("format"));
  if (wanted) {
    wanted.checked = true;
    const panel = wanted.closest(".tabs__panel");
    if (panel?.id) document.querySelector(`.tabs__tab[aria-controls="${panel.id}"]`)?.click();
  }
  const transcript = $(".compose__transcript");
  const empty = $(".compose__empty");
  const notice = $(".compose__notice");
  const challenge = $(".compose__challenge");
  const form = $(".compose__form");
  const input = $(".compose__input");
  const send = $(".compose__send");
  const status = $(".compose__status");
  const reset = $(".compose__reset");
  const preview = $(".compose__preview");
  const stage = $(".compose__stage");
  const canvas = $(".compose__canvas");
  const placeholder = $(".compose__placeholder");
  const hint = $(".compose__hint");
  const size = $(".compose__size");
  const download = $(".compose__download");
  const copy = $(".compose__copy");
  const caption = $(".compose__caption");
  const captionIdle = caption.textContent;

  let host = null;
  let conversation = null;
  let challengeToken = null;
  let image = null;
  let replyText = "";

  const setState = (state) => { app.dataset.state = state; };
  const selected = () => {
    const checked = presets.find((preset) => preset.checked) || presets[0];
    const thumb = checked.closest(".preset").querySelector(".preset__thumb");
    const vars = Object.fromEntries((thumb.getAttribute("style") || "").split(";").map((pair) => pair.split(":").map((part) => part.trim())));
    return {
      id: checked.value,
      name: checked.dataset.name,
      prompt: checked.dataset.prompt,
      unit: checked.dataset.unit === "in" ? " in" : "",
      width: Number(vars["--cw"]) || null,
      height: Number(vars["--ch"]) || null,
      style: thumb.getAttribute("style") || "",
    };
  };

  // ---- the preview follows the preset ----
  const showPreset = () => {
    const preset = selected();
    input.placeholder = preset.prompt || "What is it about?";
    stage.setAttribute("style", preset.style);
    size.textContent = `${preset.width} × ${preset.height}${preset.unit} · PNG`;
    hint.textContent = `Your ${preset.name} appears here.`;
  };
  const clearPreview = () => {
    image = null;
    canvas.querySelector("img")?.remove();
    placeholder.hidden = false;
    download.hidden = true;
    download.removeAttribute("href");
    caption.textContent = captionIdle;
    caption.classList.remove("is-filled");
    copy.disabled = true;
    showPreset();
  };
  presets.forEach((preset) => preset.addEventListener("change", () => { clearPreview(); input.focus(); }));

  // ---- the transcript ----
  const message = (kind, text = "") => {
    const node = document.createElement("div");
    node.className = `msg msg--${kind === "user" ? "user" : "assistant"}${kind === "note" ? " msg--note" : kind === "error" ? " msg--error" : ""}`;
    if (kind !== "user") node.dataset.initial = name.trim().charAt(0).toUpperCase() || "·";
    const body = document.createElement("span");
    body.textContent = text;
    node.append(body);
    empty.hidden = true;
    reset.hidden = false;
    transcript.append(node);
    return { node, body };
  };

  // ---- allowance and states ----
  const period = (allowance) => (allowance.period ? ` this ${allowance.period}` : "");
  const showAllowance = () => {
    const allowance = host?.allowance;
    if (!allowance || typeof allowance.remaining !== "number") { status.textContent = ""; return; }
    const total = typeof allowance.total === "number" ? ` of ${allowance.total}` : "";
    status.textContent = allowance.remaining === 0 ? `No free pieces left${period(allowance)}.` : `${allowance.remaining}${total} free piece${allowance.remaining === 1 ? "" : "s"} left${period(allowance)}.`;
  };
  const showNotice = (title, text, action) => {
    notice.replaceChildren();
    const heading = document.createElement("b");
    heading.textContent = title;
    notice.append(heading, document.createTextNode(text || ""));
    if (action && action.href && action.label) {
      const link = document.createElement("a");
      link.href = action.href;
      link.textContent = action.label;
      notice.append(document.createTextNode(" "), link);
    }
    notice.hidden = false;
  };
  const off = () => {
    setState("off");
    showNotice("Composing is not open on this system.", ` The presets above are what ${name} makes; to get them produced, start from Install or ask the studio that keeps the system.`, host?.contact);
    status.textContent = "";
  };
  const exhausted = (text, action) => {
    setState("exhausted");
    showNotice("The free allowance is used up.", ` ${text || "Nothing more can be composed here until it is renewed."}`, action || host?.contact);
    showAllowance();
  };
  const ready = () => {
    notice.hidden = true;
    setState("ready");
    showAllowance();
  };

  // ---- the human check, when the host asks for one ----
  const askChallenge = (siteKey) => new Promise((resolve) => {
    if (challengeToken) { resolve(challengeToken); return; }
    challenge.hidden = false;
    const render = () => window.turnstile.render(challenge, { sitekey: siteKey, callback: (token) => { challengeToken = token; challenge.hidden = true; resolve(token); } });
    if (window.turnstile) { render(); return; }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = render;
    script.onerror = () => { challenge.hidden = true; resolve(null); };
    document.head.append(script);
  });

  // ---- one message, streamed back ----
  const events = async function* (response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event = "message";
        const data = [];
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        try { yield { event, data: JSON.parse(data.join("\n")) }; } catch { /* a malformed event is skipped */ }
      }
    }
  };

  const submit = async (text) => {
    const preset = selected();
    if (!text.trim() || app.dataset.state !== "ready") return;
    if (host?.challenge?.siteKey && !challengeToken) {
      const token = await askChallenge(host.challenge.siteKey);
      if (!token) { message("note", "The human check could not load; try again in a moment."); return; }
    }
    setState("busy");
    send.disabled = true;
    input.value = "";
    input.style.height = "";
    message("user", text.trim());
    const reply = message("assistant", "");
    reply.node.classList.add("is-live");
    replyText = "";
    let spent = false;
    placeholder.hidden = false;
    canvas.querySelector("img")?.remove();
    download.hidden = true;
    const finish = () => {
      reply.node.classList.remove("is-live");
      if (!replyText && reply.node.classList.contains("msg--assistant") && !reply.node.classList.contains("msg--error")) reply.node.remove();
      if (app.dataset.state === "busy") (spent ? exhausted : ready)();
      send.disabled = false;
      input.focus();
    };
    try {
      const response = await fetch(route, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ conversation, preset: { id: preset.id, name: preset.name, width: preset.width, height: preset.height }, message: text.trim(), challenge: challengeToken }),
      });
      if (!response.ok || !response.body) {
        if (response.status === 404 || response.status === 501) { reply.node.remove(); off(); return; }
        if (response.status === 429 || response.status === 402) { reply.node.remove(); exhausted(); return; }
        throw new Error(`The host answered ${response.status}.`);
      }
      for await (const { event, data } of events(response)) {
        if (event === "conversation") conversation = data.token || conversation;
        else if (event === "text") {
          replyText += data.delta || "";
          reply.body.textContent = replyText;
        } else if (event === "caption") {
          caption.textContent = data.text || "";
          caption.classList.add("is-filled");
          copy.disabled = !data.text;
        } else if (event === "image" && data.url) {
          image = data;
          const img = document.createElement("img");
          img.src = data.url;
          img.alt = `${preset.name} made for ${name}`;
          placeholder.hidden = true;
          canvas.append(img);
          download.href = data.download || data.url;
          download.download = `${name.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "image"}-${preset.id}.${(data.type || "png").toLowerCase()}`;
          download.hidden = false;
        } else if (event === "allowance") {
          host = { ...(host || {}), allowance: data };
          spent = data.remaining === 0;
          showAllowance();
        } else if (event === "error") {
          if (data.code === "exhausted") { reply.node.remove(); replyText = ""; exhausted(data.message, data.action); return; }
          if (data.code === "off") { reply.node.remove(); replyText = ""; off(); return; }
          if (data.code === "challenge") challengeToken = null;
          reply.node.classList.add("msg--error");
          replyText = data.message || "That did not work; try again.";
          reply.body.textContent = replyText;
        } else if (event === "done") break;
      }
    } catch (error) {
      reply.node.classList.add("msg--error");
      replyText = `Something went wrong: ${error.message} Try again in a moment.`;
      reply.body.textContent = replyText;
    } finally {
      finish();
    }
  };

  // ---- wiring ----
  form.addEventListener("submit", (event) => { event.preventDefault(); submit(input.value); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(input.value); }
  });
  input.addEventListener("input", () => { input.style.height = ""; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; });
  for (const chip of app.querySelectorAll(".compose__chip")) {
    chip.addEventListener("click", () => { input.value = chip.dataset.prompt || chip.textContent; input.dispatchEvent(new Event("input")); input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  }
  reset.addEventListener("click", () => {
    conversation = null;
    transcript.querySelectorAll(".msg").forEach((node) => node.remove());
    empty.hidden = false;
    reset.hidden = true;
    clearPreview();
    if (app.dataset.state === "busy") return;
    input.focus();
  });
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(caption.textContent.trim()); copy.textContent = "Copied"; }
    catch { copy.textContent = "Select and copy"; }
    setTimeout(() => { copy.textContent = "Copy"; }, 1600);
  });

  showPreset();
  fetch(route, { headers: { Accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((answer) => {
      host = answer && typeof answer === "object" ? answer : null;
      if (!host || host.enabled !== true) { off(); return; }
      if (host.allowance && host.allowance.remaining === 0) { exhausted(); return; }
      ready();
    })
    .catch(off);
})();
