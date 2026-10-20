/**
 * Token Atelier (Foundry VTT v13/v14, dnd5e)
 *
 * Alignment model: each art stores a transform normalised to the token canvas:
 *   ox, oy  - image centre offset from canvas centre, as a fraction of canvas size
 *   scale   - displayed image width as a fraction of canvas width
 *   rot     - rotation in degrees
 * Because these are fractions (not pixels), the same transform lines up any
 * image with the same framing, whatever its resolution.
 *
 * Arts are "linked" by default: they all read and edit one shared transform
 * stored on the actor. Unlink an art to give it its own transform.
 */

const MOD = "token-atelier";
const OPEN_ACTION = "tokenAtelierOpen";

/** Only Game Masters may use the token designer. */
const isGM = () => game.user?.isGM === true;
const DEFAULT_TF = { ox: 0, oy: 0, scale: 1, rot: 0 };
const imageCache = new Map();

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** The FilePicker implementation (namespaced in v13+). */
const filePicker = () => foundry.applications.apps.FilePicker.implementation;

/* -------------------------------------------- */
/*  Helpers                                      */
/* -------------------------------------------- */

function resolveSrc(src) {
  if (!src) return "";
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  return foundry.utils.getRoute(src);
}

function loadImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = resolveSrc(src);
  });
  promise.catch(() => imageCache.delete(src));
  imageCache.set(src, promise);
  return promise;
}

function baseName(path) {
  const file = String(path).split("/").pop().split("?")[0];
  try { return decodeURIComponent(file).replace(/\.[^.]+$/, "") || "art"; }
  catch (e) { return file.replace(/\.[^.]+$/, "") || "art"; }
}

function slug(text, fallback = "token") {
  const s = String(text ?? "").trim().slugify({ strict: true });
  return s || fallback;
}

/** Cover-fit transform: fills the canvas; tall images are aligned to the top (where faces usually are). */
function fitTransform(img) {
  const ar = img.naturalHeight / img.naturalWidth;
  const scale = Math.max(1, 1 / ar);
  const oy = ar > 1 ? (scale * ar) / 2 - 0.5 : 0;
  return { ox: 0, oy, scale, rot: 0 };
}

async function ensureFolder(path) {
  const FP = filePicker();
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    const parent = current;
    current = current ? `${current}/${part}` : part;
    let exists = false;
    try {
      const result = await FP.browse("data", parent, {});
      exists = result.dirs.some(d => d === current || decodeURIComponent(d) === current);
    } catch (e) { /* fall through and try to create */ }
    if (!exists) {
      try { await FP.createDirectory("data", current, {}); }
      catch (e) { /* most likely already exists */ }
    }
  }
}

function defaultState() {
  return {
    version: 1,
    active: null,
    arts: [],
    shared: { ...DEFAULT_TF, initialized: false },
    style: {
      mask: "circle",
      frame: "ring",
      ringColor: "#c9a227",
      ringWidth: 3,
      bgTransparent: true,
      bgColor: "#222222",
      customFrame: "",
      size: 512,
      folder: game.settings.get(MOD, "defaultFolder") || "token-atelier",
      applyToken: true,
      applyPortrait: false
    }
  };
}

function loadState(actor) {
  const base = defaultState();
  const stored = actor.getFlag(MOD, "data");
  if (!stored) return base;
  const state = foundry.utils.mergeObject(base, foundry.utils.deepClone(stored), { inplace: false });
  if (!state.arts.some(a => a.id === state.active)) state.active = state.arts[0]?.id ?? null;
  return state;
}

/* -------------------------------------------- */
/*  Application                                  */
/* -------------------------------------------- */

class TokenAtelierApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    // Protect direct instantiation as well as all public entry points.
    if (!isGM()) throw new Error("Token Atelier is restricted to Game Masters.");
    super(foundry.utils.mergeObject({ id: `${MOD}-${actor.id}` }, options));
    this.actor = actor;
    // ApplicationV2.state is a read-only render lifecycle getter in Foundry 13/14.
    // Keep our editable token data under a separate property.
    this.atelierData = loadState(actor);
    this._img = null;
    this._frameImg = null;
    this._frameMask = null;
    this._layer = null;
    this._saveTimer = null;
    this._drag = null;
    this.canvas = null;
  }

  static DEFAULT_OPTIONS = {
    classes: ["token-atelier"],
    position: { width: 780, height: "auto" },
    window: { icon: "fa-solid fa-user-circle", resizable: false },
    actions: {
      "select-art": TokenAtelierApp.onSelectArt,
      "add-art": TokenAtelierApp.onAddArt,
      "add-portrait": TokenAtelierApp.onAddPortrait,
      "remove-art": TokenAtelierApp.onRemoveArt,
      "pick-frame": TokenAtelierApp.onPickFrame,
      "set-shared": TokenAtelierApp.onSetShared,
      "reset": TokenAtelierApp.onReset,
      "export": TokenAtelierApp.onExport
    }
  };

  static PARTS = {
    main: { template: `modules/${MOD}/templates/token-atelier.hbs` }
  };

  get title() {
    return `${game.i18n.localize("TOKEN_ATELIER.Title")}: ${this.actor.name}`;
  }

  get art() {
    return this.atelierData.arts.find(a => a.id === this.atelierData.active) ?? null;
  }

  /** The transform currently being edited: the shared one when linked, otherwise the art's own. */
  get tf() {
    const art = this.art;
    if (!art) return { ...DEFAULT_TF };
    return art.linked ? this.atelierData.shared : art.tf;
  }

  async _prepareContext(options) {
    return {
      arts: this.atelierData.arts.map(a => ({
        id: a.id,
        label: a.label,
        thumb: resolveSrc(a.src),
        active: a.id === this.atelierData.active
      }))
    };
  }

  /* ---------- persistence ---------- */

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 500);
  }

  async _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!isGM() || !this.actor.isOwner) return;
    try {
      await this.actor.setFlag(MOD, "data", foundry.utils.deepClone(this.atelierData));
    } catch (err) {
      console.error(`${MOD} | Could not save state`, err);
    }
  }

  async close(options) {
    if (this._saveTimer) await this._save();
    return super.close(options);
  }

  /* ---------- rendering and listeners ---------- */

  _onRender(context, options) {
    const root = this.element;
    this.canvas = root.querySelector("canvas");
    this.canvas.width = this.canvas.height = this.atelierData.style.size;

    // Populate bound inputs from state
    root.querySelectorAll("[data-bind]").forEach(el => {
      const value = foundry.utils.getProperty(this.atelierData, el.dataset.bind);
      if (el.type === "checkbox") el.checked = !!value;
      else el.value = value ?? "";

      const handler = () => {
        let v = el.type === "checkbox" ? el.checked : el.value;
        if (el.dataset.type === "number") v = Number(v);
        foundry.utils.setProperty(this.atelierData, el.dataset.bind, v);
        this._onStyleChanged(el.dataset.bind);
      };
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    });

    // Sliders and link checkbox
    root.querySelector('input[name="scale"]').addEventListener("input", ev => {
      this.tf.scale = Number(ev.currentTarget.value);
      this._markShared();
      this._draw();
      this._scheduleSave();
    });
    root.querySelector('input[name="rot"]').addEventListener("input", ev => {
      this.tf.rot = Number(ev.currentTarget.value);
      this._markShared();
      this._draw();
      this._scheduleSave();
    });
    root.querySelector('input[name="linked"]').addEventListener("change", ev => {
      const art = this.art;
      if (!art) return;
      if (ev.currentTarget.checked) {
        art.linked = true;
      } else {
        const s = this.atelierData.shared;
        art.tf = { ox: s.ox, oy: s.oy, scale: s.scale, rot: s.rot };
        art.linked = false;
      }
      this._syncControls();
      this._draw();
      this._scheduleSave();
    });

    // Art labels
    root.querySelectorAll(".tka-label").forEach(el => {
      el.addEventListener("change", ev => {
        const id = ev.currentTarget.closest(".tka-art").dataset.id;
        const art = this.atelierData.arts.find(a => a.id === id);
        if (art) art.label = ev.currentTarget.value.trim() || art.label;
        this._scheduleSave();
      });
    });

    // Canvas interaction
    const canvas = this.canvas;
    canvas.addEventListener("pointerdown", ev => {
      if (!this._img) return;
      canvas.setPointerCapture(ev.pointerId);
      canvas.classList.add("dragging");
      this._drag = { x: ev.clientX, y: ev.clientY };
    });
    canvas.addEventListener("pointermove", ev => {
      if (!this._drag) return;
      const rect = canvas.getBoundingClientRect();
      const tf = this.tf;
      tf.ox += (ev.clientX - this._drag.x) / rect.width;
      tf.oy += (ev.clientY - this._drag.y) / rect.height;
      this._drag = { x: ev.clientX, y: ev.clientY };
      this._markShared();
      this._draw();
    });
    const endDrag = () => {
      if (!this._drag) return;
      this._drag = null;
      canvas.classList.remove("dragging");
      this._scheduleSave();
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("wheel", ev => {
      if (!this._img) return;
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const tf = this.tf;
      const px = (ev.clientX - rect.left) / rect.width - 0.5;
      const py = (ev.clientY - rect.top) / rect.height - 0.5;
      const next = Math.min(6, Math.max(0.05, tf.scale * Math.exp(-ev.deltaY * 0.0015)));
      const k = next / tf.scale;
      tf.ox = px + (tf.ox - px) * k;
      tf.oy = py + (tf.oy - py) * k;
      tf.scale = next;
      this._markShared();
      this._syncControls();
      this._draw();
      this._scheduleSave();
    }, { passive: false });

    this._prepareCanvas();
  }

  async _prepareCanvas() {
    const art = this.art;
    this._img = null;
    if (art) {
      try {
        this._img = await loadImage(art.src);
      } catch (err) {
        ui.notifications.warn(`Token Atelier: could not load ${art.src}`);
      }
    }
    if (this._img && art.linked && !this.atelierData.shared.initialized) {
      Object.assign(this.atelierData.shared, fitTransform(this._img), { initialized: true });
      this._scheduleSave();
    }
    await this._loadFrame();
    this._syncControls();
    this._draw();
  }

  async _loadFrame() {
    const { frame, customFrame } = this.atelierData.style;
    this._frameImg = null;
    this._frameMask = null;
    if (frame !== "custom" || !customFrame) return;
    try {
      this._frameImg = await loadImage(customFrame);
    } catch (err) {
      ui.notifications.warn(`Token Atelier: could not load frame ${customFrame}`);
      return;
    }
    this._buildFrameMask();
  }

  /**
   * Work out which part of the frame image is its "window": the transparent region
   * connected to the centre. Art is clipped to that region so it never pokes out past
   * the frame border, whatever shape the frame has.
   */
  _buildFrameMask() {
    this._frameMask = null;
    if (!this._frameImg || !this.canvas) return;
    const S = this.canvas.width;
    try {
      const scratch = document.createElement("canvas");
      scratch.width = scratch.height = S;
      const sctx = scratch.getContext("2d", { willReadFrequently: true });
      sctx.drawImage(this._frameImg, 0, 0, S, S);
      const data = sctx.getImageData(0, 0, S, S).data;

      const open = i => data[i * 4 + 3] < 128;
      const start = (S >> 1) * S + (S >> 1);
      if (!open(start)) return; // the frame covers the centre; fall back to the shape mask

      const seen = new Uint8Array(S * S);
      const stack = new Int32Array(S * S);
      let sp = 0;
      let leaks = false;
      seen[start] = 1;
      stack[sp++] = start;
      while (sp) {
        const p = stack[--sp];
        const px = p % S;
        const py = (p / S) | 0;
        if (px === 0 || py === 0 || px === S - 1 || py === S - 1) leaks = true;
        if (px > 0 && !seen[p - 1] && open(p - 1)) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (px < S - 1 && !seen[p + 1] && open(p + 1)) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (py > 0 && !seen[p - S] && open(p - S)) { seen[p - S] = 1; stack[sp++] = p - S; }
        if (py < S - 1 && !seen[p + S] && open(p + S)) { seen[p + S] = 1; stack[sp++] = p + S; }
      }
      if (leaks) {
        ui.notifications.warn("Token Atelier: this frame's window is not closed, so the chosen shape is used to trim the art instead.");
        return;
      }

      const raw = document.createElement("canvas");
      raw.width = raw.height = S;
      const rctx = raw.getContext("2d");
      const out = rctx.createImageData(S, S);
      for (let i = 0; i < S * S; i++) if (seen[i]) out.data[i * 4 + 3] = 255;
      rctx.putImageData(out, 0, 0);

      // Grow the window a little so art tucks under the frame edge with no gap
      const grown = document.createElement("canvas");
      grown.width = grown.height = S;
      const gctx = grown.getContext("2d");
      const d = Math.max(1, Math.round(S / 256));
      for (const dx of [-d, 0, d]) for (const dy of [-d, 0, d]) gctx.drawImage(raw, dx, dy);
      this._frameMask = grown;
    } catch (err) {
      console.warn(`${MOD} | Could not read the frame image to build a mask`, err);
    }
  }

  _markShared() {
    const art = this.art;
    if (art?.linked) this.atelierData.shared.initialized = true;
  }

  _syncControls() {
    const root = this.element;
    if (!root) return;
    const tf = this.tf;
    const scale = root.querySelector('input[name="scale"]');
    const rot = root.querySelector('input[name="rot"]');
    const linked = root.querySelector('input[name="linked"]');
    if (scale) scale.value = tf.scale;
    if (rot) rot.value = tf.rot;
    if (linked) linked.checked = this.art ? this.art.linked : true;
  }

  async _onStyleChanged(path) {
    if (path === "style.size") {
      this.canvas.width = this.canvas.height = this.atelierData.style.size;
    }
    if (path === "style.customFrame" || path === "style.frame" || path === "style.size") {
      await this._loadFrame();
    }
    this._draw();
    this._scheduleSave();
  }

  /* ---------- actions (called with the app as `this`) ---------- */

  static onSelectArt(event, target) {
    if (event.target.closest("input, button")) return;
    const id = target.dataset.id;
    if (id === this.atelierData.active) return;
    this.atelierData.active = id;
    this._scheduleSave();
    this.render();
  }

  static onAddArt() {
    const FP = filePicker();
    new FP({ type: "image", callback: path => this._addArt(path) }).browse()
      .catch(err => { console.error(`${MOD} | Art picker failed`, err); ui.notifications.error("Token Atelier: could not open the art browser."); });
  }

  static onAddPortrait() {
    if (this.actor.img) this._addArt(this.actor.img);
  }

  static onRemoveArt(event, target) {
    const id = target.closest(".tka-art").dataset.id;
    this.atelierData.arts = this.atelierData.arts.filter(a => a.id !== id);
    if (this.atelierData.active === id) this.atelierData.active = this.atelierData.arts[0]?.id ?? null;
    this._scheduleSave();
    this.render();
  }

  static onPickFrame() {
    const FP = filePicker();
    new FP({
      type: "image",
      callback: path => {
        this.atelierData.style.frame = "custom";
        this.atelierData.style.customFrame = path;
        this._scheduleSave();
        this.render();
      }
    }).browse().catch(err => {
      console.error(`${MOD} | Frame picker failed`, err);
      ui.notifications.error("Token Atelier: could not open the frame browser.");
    });
  }

  static onSetShared() {
    const art = this.art;
    if (!art) return;
    const tf = this.tf;
    Object.assign(this.atelierData.shared, { ox: tf.ox, oy: tf.oy, scale: tf.scale, rot: tf.rot, initialized: true });
    art.linked = true;
    this._scheduleSave();
    this._syncControls();
    this._draw();
    ui.notifications.info("Token Atelier: shared alignment saved. All linked art now uses it.");
  }

  static onReset() {
    if (!this._img) return;
    Object.assign(this.tf, fitTransform(this._img));
    this._markShared();
    this._syncControls();
    this._draw();
    this._scheduleSave();
  }

  static async onExport() {
    await this._export();
  }

  _addArt(src) {
    const art = {
      id: foundry.utils.randomID(),
      src,
      label: baseName(src),
      linked: true,
      tf: { ...DEFAULT_TF }
    };
    this.atelierData.arts.push(art);
    this.atelierData.active = art.id;
    this._scheduleSave();
    this.render();
  }

  /* ---------- drawing ---------- */

  _maskPath(ctx, S, mask, inset = 0) {
    const x = inset, y = inset, w = S - inset * 2, h = S - inset * 2;
    ctx.beginPath();
    if (mask === "circle") {
      ctx.arc(S / 2, S / 2, w / 2, 0, Math.PI * 2);
    } else if (mask === "rounded") {
      const r = S * 0.18;
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    } else {
      ctx.rect(x, y, w, h);
    }
  }

  _paintArt(ctx, S, st) {
    if (!st.bgTransparent) {
      ctx.fillStyle = st.bgColor;
      ctx.fillRect(0, 0, S, S);
    }
    if (!this._img) return;
    const tf = this.tf;
    const w = tf.scale * S;
    const h = w * (this._img.naturalHeight / this._img.naturalWidth);
    ctx.save();
    ctx.translate(S / 2 + tf.ox * S, S / 2 + tf.oy * S);
    ctx.rotate((tf.rot * Math.PI) / 180);
    ctx.drawImage(this._img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  _draw() {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const S = canvas.width;
    const st = this.atelierData.style;
    ctx.clearRect(0, 0, S, S);

    if (st.frame === "custom" && this._frameMask && this._frameMask.width === S) {
      // Trim the art to the frame's own window rather than a generic shape
      if (!this._layer) this._layer = document.createElement("canvas");
      const layer = this._layer;
      layer.width = layer.height = S;
      const lctx = layer.getContext("2d");
      lctx.clearRect(0, 0, S, S);
      this._paintArt(lctx, S, st);
      lctx.globalCompositeOperation = "destination-in";
      lctx.drawImage(this._frameMask, 0, 0);
      lctx.globalCompositeOperation = "source-over";
      ctx.drawImage(layer, 0, 0);
    } else {
      ctx.save();
      this._maskPath(ctx, S, st.mask);
      ctx.clip();
      this._paintArt(ctx, S, st);
      ctx.restore();
    }

    if (st.frame === "ring" && st.ringWidth > 0) {
      const lw = (st.ringWidth / 100) * S;
      ctx.save();
      this._maskPath(ctx, S, st.mask, lw / 2);
      ctx.lineWidth = lw;
      ctx.strokeStyle = st.ringColor;
      ctx.stroke();
      ctx.restore();
    } else if (st.frame === "custom" && this._frameImg) {
      ctx.drawImage(this._frameImg, 0, 0, S, S);
    }
  }

  /* ---------- export ---------- */

  async _export() {
    if (!isGM()) {
      ui.notifications.warn("Token Atelier is available only to Game Masters.");
      return;
    }
    const art = this.art;
    if (!art || !this._img) {
      ui.notifications.warn("Token Atelier: add and select some art first.");
      return;
    }
    if (!game.user.can("FILES_UPLOAD")) {
      ui.notifications.error("Token Atelier: you do not have permission to upload files.");
      return;
    }
    const st = this.atelierData.style;
    this._draw();

    let blob;
    try {
      blob = await new Promise((resolve, reject) => {
        this.canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Empty image"))), "image/png");
      });
    } catch (err) {
      console.error(`${MOD} | Export failed`, err);
      ui.notifications.error("Token Atelier: could not export. Images hosted outside Foundry can block this; copy the art into your Foundry data folder.");
      return;
    }

    try {
      const folder = (st.folder || "").trim().replace(/^\/+|\/+$/g, "") || "token-atelier";
      await ensureFolder(folder);
      const name = `${slug(this.actor.name, "actor")}-${slug(art.label, "art")}.png`;
      const file = new File([blob], name, { type: "image/png" });
      const response = await filePicker().upload("data", folder, file, {}, { notify: false });
      if (!response?.path) throw new Error("Upload returned no path");

      const update = {};
      if (st.applyToken) update["prototypeToken.texture.src"] = response.path;
      if (st.applyPortrait) update.img = response.path;
      if (Object.keys(update).length) await this.actor.update(update);

      await this._save();
      ui.notifications.info(`Token Atelier: saved ${response.path}`);
    } catch (err) {
      console.error(`${MOD} | Upload failed`, err);
      ui.notifications.error("Token Atelier: could not save the token. Check the console for details.");
    }
  }
}

/* -------------------------------------------- */
/*  Hooks                                        */
/* -------------------------------------------- */

/** Open the editor, reporting any failed render instead of silently swallowing it. */
async function openAtelier(actor) {
  if (!isGM()) {
    ui.notifications.warn("Token Atelier is available only to Game Masters.");
    return null;
  }
  if (!actor) {
    ui.notifications.warn("Token Atelier: select an actor first.");
    return null;
  }
  try {
    // AppV2 windows are indexed by string ID in Foundry v13/14.
    const id = `${MOD}-${actor.id}`;
    const existing = foundry.applications.instances.get(id);
    if (existing instanceof TokenAtelierApp) {
      if (!existing.rendered) await existing.render({ force: true });
      existing.bringToFront();
      return existing;
    }
    const app = new TokenAtelierApp(actor);
    await app.render({ force: true });
    app.bringToFront();
    return app;
  } catch (err) {
    console.error(`${MOD} | Failed to open token editor`, err);
    ui.notifications.error("Token Atelier: couldn't open the editor. Press F12 and check the Console for details.");
    return null;
  }
}

Hooks.once("init", () => {
  game.settings.register(MOD, "defaultFolder", {
    name: "TOKEN_ATELIER.Setting.Folder.Name",
    hint: "TOKEN_ATELIER.Setting.Folder.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "token-atelier"
  });
  game.modules.get(MOD).api = { open: openAtelier };
});

/** Header button on actor sheets (all dnd5e sheets are ActorSheetV2 based). */
Hooks.on("getHeaderControlsActorSheetV2", (app, controls) => {
  const actor = app.actor ?? app.document;
  if (!isGM() || !actor?.isOwner) return;
  if (controls.some(c => c.action === OPEN_ACTION)) return;

  controls.push({
    icon: "fa-solid fa-user-circle",
    label: "TOKEN_ATELIER.Button",
    action: OPEN_ACTION,
    ownership: "OWNER",
    onClick: () => void openAtelier(actor)
  });
});

/** Right-click entry in the Actors sidebar. */
Hooks.on("getActorContextOptions", (application, menuItems) => {
  if (!isGM()) return;
  const getActor = el => {
    const node = el instanceof HTMLElement ? el : el?.[0];
    const id = node?.dataset?.entryId ?? node?.dataset?.documentId;
    return id ? game.actors.get(id) : null;
  };
  menuItems.push({
    name: "TOKEN_ATELIER.Title",
    icon: '<i class="fa-solid fa-user-circle"></i>',
    condition: el => isGM() && !!getActor(el)?.isOwner,
    callback: el => openAtelier(getActor(el))
  });
});
