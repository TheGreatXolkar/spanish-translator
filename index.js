(function () {
  "use strict";

  // ---- Revenge / Vendetta-compatible APIs ----
  const { FluxDispatcher, React, ReactNative } = vendetta.metro.common;
  const { findByStoreName } = vendetta.metro;
  const { useProxy } = vendetta.storage;
  const { Forms } = vendetta.ui.components;
  const { FormSwitchRow, FormDivider } = Forms;
  const storage = vendetta.plugin.storage;
  const log = vendetta.logger;

  // ---- Settings defaults ----
  if (storage.autoTranslate === undefined) storage.autoTranslate = true;       // translate incoming messages live
  if (storage.showOriginal === undefined) storage.showOriginal = true;         // keep Spanish text above the translation
  if (storage.translateHistory === undefined) storage.translateHistory = true; // translate recent messages when opening a channel

  const MARKER = "\u200B\uD83C\uDF10"; // zero-width space + globe, marks our edits
  const HISTORY_LIMIT = 25;            // newest messages translated per channel load
  const SPACING_MS = 250;              // gap between requests (avoids rate limits)
  const GOOGLE_COOLDOWN_MS = 5 * 60 * 1000;
  const LINGVA_INSTANCES = ["https://lingva.ml", "https://lingva.lunar.icu"];

  // ---- Spanish pre-check (so English messages are never sent anywhere) ----
  const ES_WORDS = new Set((
    "que qué el la los las un una unos unas es son está están estoy estás esta este esto eso esa ese " +
    "por para pero porque como cómo cuando cuándo donde dónde quien quién y o del al con sin muy más " +
    "yo tú tu usted ustedes nosotros ellos ella él mi mis su sus te se lo le les nos " +
    "hola gracias bueno buena buenos buenas sí si también ya hay hace hacer tengo tiene tienes " +
    "quiero quieres puedo puedes vamos vale claro nada todo todos algo aquí allí ahora hoy mañana " +
    "ayer amigo amiga juego jugar sabes creo verdad oye pues entonces jaja jajaja xd"
  ).split(" "));

  function looksSpanish(text) {
    if (!text || text.length > 2000) return false;
    if (/[ñ¿¡]/i.test(text)) return true;
    const words = text.toLowerCase().match(/[a-záéíóúüñ]+/g) || [];
    if (words.length === 0) return false;
    const hits = words.filter((w) => ES_WORDS.has(w)).length;
    return hits >= 1 && hits / words.length >= 0.25;
  }

  // ---- Protect mentions, emojis, links, code from being translated ----
  function protect(text) {
    const tokens = [];
    const masked = text.replace(/```[\s\S]*?```|`[^`]*`|<[^>]+>|https?:\/\/\S+|:\w+:/g, (m) => {
      tokens.push(m);
      return "{" + (tokens.length - 1) + "}";
    });
    return { masked, tokens };
  }
  function restore(text, tokens) {
    return text.replace(/\{\s*(\d+)\s*\}/g, (m, i) => (tokens[i] !== undefined ? tokens[i] : m));
  }

  // ---- Translation backends ----
  let googleBlockedUntil = 0;

  async function googleTranslate(text) {
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" +
      encodeURIComponent(text);
    const res = await fetch(url);
    if (!res.ok) throw new Error("Google HTTP " + res.status);
    const data = await res.json();
    const translated = (data[0] || []).map((part) => part[0]).join("");
    return { text: translated, lang: data[2] };
  }

  async function lingvaTranslate(text) {
    for (const base of LINGVA_INSTANCES) {
      try {
        const res = await fetch(base + "/api/v1/es/en/" + encodeURIComponent(text));
        if (!res.ok) continue;
        const data = await res.json();
        if (data && data.translation) return { text: data.translation, lang: "es" };
      } catch (e) { /* try next instance */ }
    }
    throw new Error("All Lingva instances failed");
  }

  async function translate(text) {
    if (Date.now() >= googleBlockedUntil) {
      try {
        return await googleTranslate(text);
      } catch (e) {
        log.warn("[SpanishTranslator] Google failed, switching to fallback for 5 min:", e.message);
        googleBlockedUntil = Date.now() + GOOGLE_COOLDOWN_MS;
      }
    }
    return await lingvaTranslate(text);
  }

  // ---- Request queue: one at a time, spaced out ----
  const queue = [];
  let pumping = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function enqueue(text) {
    return new Promise((resolve) => {
      queue.push({ text, resolve });
      pump();
    });
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const job = queue.shift();
      try { job.resolve(await translate(job.text)); }
      catch (e) { job.resolve(null); }
      await sleep(SPACING_MS);
    }
    pumping = false;
  }

  // ---- Cache (message id -> translated content) ----
  const cache = new Map();
  const pending = new Set();
  function remember(id, value) {
    cache.set(id, value);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }

  function formatContent(original, translated) {
    const lines = translated.split("\n").map((l, i) => "-# " + (i === 0 ? MARKER + " " : "") + l);
    if (storage.showOriginal) return original + "\n" + lines.join("\n");
    return translated + "\n-# " + MARKER + " translated from Spanish";
  }

  function applyTranslation(message, content) {
    FluxDispatcher.dispatch({
      type: "MESSAGE_UPDATE",
      message: Object.assign({}, message, { content }),
      log_edit: false,
    });
  }

  async function handleMessage(message) {
    try {
      if (!message || !message.id || typeof message.content !== "string") return;
      if (message.content.includes(MARKER)) return;
      const me = findByStoreName("UserStore").getCurrentUser();
      if (me && message.author && message.author.id === me.id) return;

      if (cache.has(message.id)) {
        const cached = cache.get(message.id);
        if (cached) applyTranslation(message, cached);
        return;
      }
      if (pending.has(message.id) || !looksSpanish(message.content)) return;

      pending.add(message.id);
      const { masked, tokens } = protect(message.content);
      const result = await enqueue(masked);
      pending.delete(message.id);

      // Google double-checks the language; skip if it isn't actually Spanish.
      if (!result || result.lang !== "es" || !result.text) { remember(message.id, null); return; }

      const translated = restore(result.text, tokens);
      if (translated.trim().toLowerCase() === message.content.trim().toLowerCase()) {
        remember(message.id, null);
        return;
      }
      const content = formatContent(message.content, translated);
      remember(message.id, content);
      applyTranslation(message, content);
    } catch (e) {
      log.error("[SpanishTranslator] " + (e && e.message));
    }
  }

  // ---- Discord event hooks ----
  function onMessageCreate(action) {
    if (!storage.autoTranslate || action.optimistic) return;
    handleMessage(action.message);
  }
  function onMessagesLoaded(action) {
    if (!storage.autoTranslate || !storage.translateHistory) return;
    (action.messages || []).slice(0, HISTORY_LIMIT).forEach(handleMessage);
  }

  // ---- Settings screen ----
  function Settings() {
    useProxy(storage);
    const row = (key, label, subLabel) =>
      React.createElement(FormSwitchRow, {
        label, subLabel,
        value: storage[key],
        onValueChange: (v) => { storage[key] = v; },
      });
    return React.createElement(
      ReactNative.ScrollView, null,
      row("autoTranslate", "Auto-translate", "Translate Spanish messages as they arrive"),
      React.createElement(FormDivider, null),
      row("translateHistory", "Translate recent history", "Translate the newest messages when you open a channel"),
      React.createElement(FormDivider, null),
      row("showOriginal", "Show original", "Keep the Spanish text above the English translation")
    );
  }

  return {
    onLoad() {
      FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
      FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onMessagesLoaded);
    },
    onUnload() {
      FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
      FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", onMessagesLoaded);
      queue.length = 0;
    },
    settings: Settings,
  };
})()
