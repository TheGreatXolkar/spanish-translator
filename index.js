(function () {
  "use strict";

  // ---- Revenge / Vendetta-compatible APIs ----
  const { FluxDispatcher, React, ReactNative } = vendetta.metro.common;
  const { findByStoreName } = vendetta.metro;
  const { useProxy } = vendetta.storage;
  const { instead } = vendetta.patcher;
  const { registerCommand } = vendetta.commands;
  const MessageActions = vendetta.metro.findByProps("sendMessage", "receiveMessage");
  const { Forms } = vendetta.ui.components;
  const { FormSwitchRow, FormDivider, FormInput } = Forms;
  const storage = vendetta.plugin.storage;
  const log = vendetta.logger;

  // ---- Settings defaults ----
  if (storage.autoTranslate === undefined) storage.autoTranslate = true;
  if (storage.showOriginal === undefined) storage.showOriginal = true;
  if (storage.translateHistory === undefined) storage.translateHistory = true;
  if (storage.translateOutgoing === undefined) storage.translateOutgoing = false;
  if (storage.outgoingShowEnglish === undefined) storage.outgoingShowEnglish = false;
  if (storage.glossary === undefined) storage.glossary = "pluma=feather, plumas=feathers";

  const MARKER = "​🌐"; // zero-width space + globe, marks our edits
  const HISTORY_LIMIT = 25;
  const SPACING_MS = 250;
  const GOOGLE_COOLDOWN_MS = 5 * 60 * 1000;
  const LINGVA_INSTANCES = ["https://lingva.ml", "https://lingva.lunar.icu"];
  const LETTERS = "A-Za-záéíóúüñÁÉÍÓÚÜÑ";
  const WORD_RE = new RegExp("[" + LETTERS + "]+", "g");

  // =====================================================================
  // 1. Language detection
  // =====================================================================
  const ES_WORDS = new Set((
    "que qué q k ke el la los las un una uno unos unas es son está están estoy estás esta este esto eso esa ese " +
    "por para pa pal pero porque xq pq xk como cómo cuando cuándo donde dónde quien quién y o del al con sin muy más " +
    "yo tú tu usted ustedes nosotros ellos ella él mi mis su sus te se lo le les nos me " +
    "hola ola gracias grax bueno buena buenos buenas sí si sip simon nel también tmb tb ya hay hace hacer " +
    "tengo tiene tienes tenias tenía quiero quieres puedo puedes vamos vale claro nada todo todos algo " +
    "aquí aki allí ahora ahorita hoy mañana alguno alguien ayer amigo amiga juego jugar sabes creo verdad vdd " +
    "oye oe pues ps pz entonces tons jaja jajaja jajajaja jsjs jsjsjs mentira ocupo ocupas dijiste dijistes " +
    "nadie nunca siempre bien bn mal mejor peor otro otra cual cuál dame dale wey güey guey neta nmms chido " +
    "compa carnal morro morra chavo vato bato pinche chale órale orale nomas nomás porfa xfa ntp tqm nse nc"
  ).split(" "));
  const EN_WORDS = new Set((
    "the a an is are was were be been i you he she it we they my your his her our their this that these those " +
    "and or but if so to of in on at for with from by about not yes yeah yep nope do does did have has had " +
    "what why how when where who which can could would should will just like get got go going want need know " +
    "lol lmao bro ok okay im its dont cant wont thanks thank please some any one all good bad"
  ).split(" "));

  function wordsOf(text) {
    return text.toLowerCase().match(WORD_RE) || [];
  }
  function spanishHits(text) {
    return wordsOf(text).filter((w) => ES_WORDS.has(w)).length;
  }
  function shouldTry(text) {
    if (!text || text.length > 2000) return false;
    if (/[ñ¿¡áéíóú]/i.test(text)) return true;
    const ws = wordsOf(text);
    if (ws.length === 0) return false;
    if (spanishHits(text) > 0) return true;
    const en = ws.filter((w) => EN_WORDS.has(w)).length;
    return en / ws.length < 0.5;
  }

  // =====================================================================
  // 2. Cleanup: turn chat Spanish into standard Spanish before translating
  //    (only the text sent to Google changes; your screen keeps the original)
  // =====================================================================
  const SLANG = {
    // abbreviations
    q: "que", k: "que", ke: "que", xq: "porque", pq: "porque", porq: "porque", xk: "porque",
    tmb: "también", tb: "también", tmbn: "también", tambn: "también", pa: "para", pal: "para el",
    bn: "bien", ps: "pues", pz: "pues", pss: "pues", toy: "estoy", tas: "estás", ta: "está",
    ntp: "no te preocupes", tqm: "te quiero mucho", tkm: "te quiero mucho", nd: "nada",
    nc: "no sé", nse: "no sé", nose: "no sé", ns: "no sé", npi: "ni idea",
    vdd: "verdad", dnd: "dónde", cnd: "cuando", xfa: "por favor", porfa: "por favor", porfis: "por favor",
    grax: "gracias", grs: "gracias", grcs: "gracias", grasias: "gracias",
    tdo: "todo", tds: "todos", msj: "mensaje", mñn: "mañana", aki: "aquí", aca: "acá", asi: "así",
    tons: "entonces", tonces: "entonces", nomas: "nada más", nomás: "nada más", ola: "hola", weno: "bueno",
    sep: "sí", sip: "sí", simon: "sí", nel: "no", nop: "no", oe: "oye", dsp: "después", dps: "después",
    jsjs: "jaja", jsjsjs: "jaja", jsjsjsjs: "jaja",
    // misspellings
    haiga: "haya", haigan: "hayan", ahy: "ahí", ahi: "ahí", aver: "a ver", enserio: "en serio",
    // Mexican / Latin American slang
    ocupo: "necesito", ocupas: "necesitas", ocupa: "necesita", ocupamos: "necesitamos", ocupan: "necesitan",
    alguno: "alguien", ahorita: "ahora",
    wey: "amigo", güey: "amigo", guey: "amigo", wei: "amigo", compa: "amigo", carnal: "hermano",
    cuate: "amigo", pana: "amigo", parce: "amigo", parcero: "amigo",
    morro: "chico", morra: "chica", chavo: "chico", chava: "chica", vato: "tipo", bato: "tipo", plebe: "chicos",
    neta: "en serio", chido: "genial", chida: "genial", chidos: "geniales", padrísimo: "genial",
    chale: "qué mal", órale: "vamos", orale: "vamos", nmms: "no puede ser", nmamz: "no puede ser",
    chamba: "trabajo", jalo: "me apunto", jalas: "te apuntas", pinche: "maldito", mijo: "hijo",
    guay: "genial", mola: "está genial",
    // gaming
    tradear: "intercambiar", tradeo: "intercambio", tradeas: "intercambias", tradeamos: "intercambiamos",
    tradeame: "intercambia conmigo", tradeen: "intercambien", farmear: "acumular", lagueando: "con lag",
  };

  let glossaryCache = { raw: null, map: {} };
  function userGlossary() {
    const raw = storage.glossary || "";
    if (raw !== glossaryCache.raw) {
      const map = {};
      raw.split(/[,\n]/).forEach((pair) => {
        const [es, en] = pair.split("=").map((s) => (s || "").trim());
        if (es && en) map[es.toLowerCase()] = en;
      });
      glossaryCache = { raw, map };
    }
    return glossaryCache.map;
  }

  function matchCase(original, rep) {
    const first = original[0];
    return first === first.toUpperCase() && first !== first.toLowerCase()
      ? rep[0].toUpperCase() + rep.slice(1)
      : rep;
  }

  function normalize(text) {
    const glossary = userGlossary();
    // "holaaaa" -> "hola", "siiii" -> "si" (keeps ll/rr/cc/nn/ee doubles)
    let out = text.replace(new RegExp("([" + LETTERS + "])\\1{2,}", "g"), (m, c) =>
      "lrcne".includes(c.toLowerCase()) ? c + c : c);
    out = out.replace(WORD_RE, (w) => {
      const lw = w.toLowerCase();
      if (glossary[lw]) return glossary[lw];
      if (SLANG[lw]) return matchCase(w, SLANG[lw]);
      // "dijistes" -> "dijiste", "hicistes" -> "hiciste"
      if (/^[a-záéíóúñ]{2,}istes$/.test(lw)) return w.slice(0, -1);
      // laughter: "jajajaja", "jaja", "JAJAJ" -> "jaja"
      if (/^(j[aeijs]){2,}j?$/.test(lw)) return "jaja";
      return w;
    });
    // capitalize start for better sentence parsing
    return out.replace(new RegExp("^([^" + LETTERS + "]*)([a-záéíóúñ])"), (m, pre, c) => pre + c.toUpperCase());
  }

  // =====================================================================
  // 3. Protect mentions, emojis, links, code
  // =====================================================================
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

  // =====================================================================
  // 4. Polish the English result
  // =====================================================================
  function polish(en) {
    let out = en
      .replace(/\b(ha){3,}h?\b/gi, "haha")      // "hahahaha" -> "haha"
      .replace(/\s+([,.!?])/g, "$1")             // "hi ," -> "hi,"
      .replace(/\s{2,}/g, " ")
      .trim();
    if (out) out = out[0].toUpperCase() + out.slice(1);
    return out;
  }

  // =====================================================================
  // 5. Translation backends
  // =====================================================================
  let googleBlockedUntil = 0;

  async function googleTranslate(text, source, target) {
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=" + source +
      "&tl=" + (target || "en") + "&dt=t&q=" + encodeURIComponent(text);
    const res = await fetch(url);
    if (!res.ok) throw new Error("Google HTTP " + res.status);
    const data = await res.json();
    const translated = (data[0] || []).map((part) => part[0]).join("");
    return { text: translated, lang: source === "auto" ? data[2] : source };
  }

  async function lingvaTranslate(text, from, to) {
    from = from || "es"; to = to || "en";
    for (const base of LINGVA_INSTANCES) {
      try {
        const res = await fetch(base + "/api/v1/" + from + "/" + to + "/" + encodeURIComponent(text));
        if (!res.ok) continue;
        const data = await res.json();
        if (data && data.translation) return { text: data.translation, lang: from };
      } catch (e) { /* try next instance */ }
    }
    throw new Error("All Lingva instances failed");
  }

  async function translate(text, source) {
    if (Date.now() >= googleBlockedUntil) {
      try {
        return await googleTranslate(text, source);
      } catch (e) {
        log.warn("[SpanishTranslator] Google failed, switching to fallback for 5 min:", e.message);
        googleBlockedUntil = Date.now() + GOOGLE_COOLDOWN_MS;
      }
    }
    if (source === "auto" && spanishHits(text) === 0) throw new Error("Fallback needs Spanish");
    return await lingvaTranslate(text);
  }

  // =====================================================================
  // 6. Outgoing: your English -> Spanish
  // =====================================================================
  const SKIP_PREFIX = "\\"; // start a message with \ to send it untranslated

  async function toSpanish(text) {
    const { masked, tokens } = protect(text);
    let result = null;
    if (Date.now() >= googleBlockedUntil) {
      try { result = await googleTranslate(masked, "auto", "es"); }
      catch (e) { googleBlockedUntil = Date.now() + GOOGLE_COOLDOWN_MS; }
    }
    if (!result) {
      try { result = await lingvaTranslate(masked, "en", "es"); } catch (e) { return null; }
    }
    if (!result || !result.text || result.lang === "es") return null; // already Spanish
    return restore(result.text, tokens).trim();
  }

  function outgoingContent(english, spanish) {
    return storage.outgoingShowEnglish ? spanish + "\n-# " + english : spanish;
  }

  async function onSend(args, orig) {
    const msg = args[1];
    try {
      const text = msg && typeof msg.content === "string" ? msg.content : "";
      if (text.startsWith(SKIP_PREFIX)) {
        msg.content = text.slice(SKIP_PREFIX.length);
      } else if (text.startsWith("/") && text.slice(1).trim()) {
        // "/your message" -> sent in Spanish (real slash commands never reach here)
        const english = text.slice(1).trim();
        const spanish = await toSpanish(english);
        msg.content = spanish ? outgoingContent(english, spanish) : english;
      } else if (storage.translateOutgoing && text.trim()) {
        const spanish = await toSpanish(text);
        if (spanish) msg.content = outgoingContent(text, spanish);
      }
    } catch (e) {
      log.error("[SpanishTranslator] outgoing: " + (e && e.message));
    }
    return orig.apply(this, args); // always sends, even if translation failed
  }

  function registerEsCommand() {
    return registerCommand({
      name: "es",
      displayName: "es",
      description: "Send a message translated to Spanish",
      displayDescription: "Send a message translated to Spanish",
      applicationId: "-1",
      inputType: 1,
      type: 1,
      options: [{
        name: "text", displayName: "text",
        description: "What you want to say in English", displayDescription: "What you want to say in English",
        type: 3, required: true,
      }],
      async execute(args, ctx) {
        const opt = args.find((a) => a.name === "text");
        const english = opt ? String(opt.value) : "";
        if (!english.trim()) return;
        const spanish = await toSpanish(english);
        MessageActions.sendMessage(ctx.channel.id, {
          content: SKIP_PREFIX + outgoingContent(english, spanish || english),
          invalidEmojis: [], validNonShortcutEmojis: [], tts: false,
        });
      },
    });
  }

  // ---- Request queue: one at a time, spaced out ----
  const queue = [];
  let pumping = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function enqueue(text, source) {
    return new Promise((resolve) => {
      queue.push({ text, source, resolve });
      pump();
    });
  }
  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const job = queue.shift();
      try { job.resolve(await translate(job.text, job.source)); }
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

  function sameText(a, b) {
    const clean = (s) => s.toLowerCase().replace(/[^a-z0-9áéíóúñ]/g, "");
    return clean(a) === clean(b);
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
      if (pending.has(message.id) || !shouldTry(message.content)) return;

      pending.add(message.id);
      const { masked, tokens } = protect(message.content);
      const prepared = normalize(masked);
      let result = await enqueue(prepared, "auto");

      // Mixed Spanish/English chat can be detected as English; retry as Spanish if it has Spanish words.
      if (result && result.lang !== "es" && spanishHits(message.content) > 0) {
        result = await enqueue(prepared, "es");
      }
      pending.delete(message.id);

      if (!result || result.lang !== "es" || !result.text) { remember(message.id, null); return; }

      const translated = polish(restore(result.text, tokens));
      if (!translated || sameText(translated, message.content)) {
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
      row("showOriginal", "Show original", "Keep the Spanish text above the English translation"),
      React.createElement(FormDivider, null),
      row("translateOutgoing", "Translate ALL my messages to Spanish", "Off: only messages starting with / are translated. On: everything is (start with \\ to skip)"),
      React.createElement(FormDivider, null),
      row("outgoingShowEnglish", "Include my English", "Add your original English in small text under the Spanish"),
      React.createElement(FormDivider, null),
      FormInput && React.createElement(FormInput, {
        title: "Game terms (spanish=english, comma separated)",
        placeholder: "pluma=feather, plumas=feathers",
        value: storage.glossary,
        onChange: (v) => { storage.glossary = v; },
        multiline: true,
      })
    );
  }

  let unpatchSend = null;
  let unregisterCommand = null;

  return {
    onLoad() {
      unpatchSend = MessageActions ? instead("sendMessage", MessageActions, onSend) : null;
      try { unregisterCommand = registerEsCommand(); } catch (e) { log.error("[SpanishTranslator] /es: " + e.message); }
      FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
      FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onMessagesLoaded);
    },
    onUnload() {
      FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
      FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", onMessagesLoaded);
      queue.length = 0;
      if (unpatchSend) unpatchSend();
      if (unregisterCommand) unregisterCommand();
    },
    settings: Settings,
  };
})()
