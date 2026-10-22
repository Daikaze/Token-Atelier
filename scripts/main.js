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

/** Bulk imports accept common raster formats supported by Foundry's image browser. */
const IMPORT_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
const MAX_ARTS_PER_ACTOR = 250; // Matches the existing JSON backup restore limit.

function imageFilename(path) {
  const tail = String(path ?? "").split(/[?#]/, 1)[0].split("/").pop() || "";
  try { return decodeURIComponent(tail); }
  catch { return tail; }
}

function isImportableImage(path) {
  const ext = imageFilename(path).match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  return IMPORT_EXTENSIONS.has(ext);
}

function artSourceKey(path) {
  const src = String(path ?? "").trim();
  try { return decodeURIComponent(src).toLowerCase(); }
  catch { return src.toLowerCase(); }
}

/** Keep imported image names intact where safe, but never overwrite existing assets. */
function uniqueImageFilename(original, used) {
  const filename = imageFilename(original);
  const ext = filename.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (!IMPORT_EXTENSIONS.has(ext)) throw new Error(`Unsupported image file: ${filename}`);
  const stem = slug(filename.slice(0, -(ext.length + 1)), "image").slice(0, 95);
  let candidate = `${stem}.${ext}`;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${stem}-${suffix++}.${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Pure import plan; existing actor art is never discarded or modified. */
function planArtImport(paths, existingArts, limit = MAX_ARTS_PER_ACTOR) {
  const seen = new Set(existingArts.map(a => artSourceKey(a.src)));
  const accepted = [];
  let skipped = 0;
  let invalid = 0;
  let overLimit = 0;
  for (const src of paths) {
    if (typeof src !== "string" || !isImportableImage(src)) { invalid++; continue; }
    const key = artSourceKey(src);
    if (seen.has(key)) { skipped++; continue; }
    if (existingArts.length + accepted.length >= limit) { overLimit++; continue; }
    seen.add(key);
    accepted.push(src);
  }
  return { accepted, skipped, invalid, overLimit };
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

/** Border presets are global to the world and never replace actor-specific data. */
const PRESET_STYLE_KEYS = ["mask", "frame", "ringColor", "ringWidth", "bgTransparent", "bgColor", "customFrame"];

function borderStyle(style) {
  const output = {};
  for (const key of PRESET_STYLE_KEYS) output[key] = foundry.utils.deepClone(style[key]);
  return output;
}

function getBorderPresets() {
  const presets = game.settings.get(MOD, "borderPresets");
  return Array.isArray(presets) ? presets.filter(p => p && typeof p.id === "string" && typeof p.name === "string" && p.style && typeof p.style === "object") : [];
}

/** Build a non-overwriting filename, using a shared set during batch operations. */
function nextAvailableName(stem, used) {
  let name = `${stem}.png`;
  let i = 2;
  while (used.has(name.toLowerCase())) name = `${stem}-${i++}.png`;
  used.add(name.toLowerCase());
  return name;
}

async function existingFilenames(folder) {
  // If the folder cannot be read, stop: never risk silently replacing a file.
  const result = await filePicker().browse("data", folder, {});
  if (!Array.isArray(result.files)) throw new Error(`Could not list ${folder}`);
  return new Set(result.files.map(src => {
    const basename = String(src).split("/").pop().split("?")[0];
    try { return decodeURIComponent(basename).toLowerCase(); }
    catch { return basename.toLowerCase(); }
  }));
}

function safeTransform(source, defaults = DEFAULT_TF) {
  const out = { ...defaults };
  for (const k of ["ox", "oy", "scale", "rot"]) {
    if (typeof source?.[k] === "number" && Number.isFinite(source[k])) out[k] = source[k];
  }
  out.scale = Math.max(0.05, Math.min(6, out.scale));
  out.rot = Math.max(-180, Math.min(180, out.rot));
  out.ox = Math.max(-20, Math.min(20, out.ox));
  out.oy = Math.max(-20, Math.min(20, out.oy));
  return out;
}

/** Validate imported JSON against the original v0.2.x state shape. */
function restoredActorData(source) {
  if (!source || typeof source !== "object" || !Array.isArray(source.arts) || !source.style || typeof source.style !== "object") {
    throw new Error("Invalid or incompatible token settings");
  }
  const out = defaultState();
  out.arts = source.arts.slice(0, 250).filter(a => a && typeof a.src === "string" && a.src.length <= 4096 && a.src.length > 0).map(a => ({
    id: typeof a.id === "string" && a.id.length <= 128 ? a.id : foundry.utils.randomID(),
    src: a.src,
    label: typeof a.label === "string" ? a.label.slice(0, 120) : baseName(a.src),
    linked: a.linked !== false,
    tf: safeTransform(a.tf)
  }));
  out.active = out.arts.some(a => a.id === source.active) ? source.active : out.arts[0]?.id ?? null;
  out.shared = { ...safeTransform(source.shared), initialized: source.shared?.initialized === true };
  const st = source.style;
  if (["circle", "rounded", "square"].includes(st.mask)) out.style.mask = st.mask;
  if (["ring", "custom", "none"].includes(st.frame)) out.style.frame = st.frame;
  for (const k of ["ringColor", "bgColor"]) if (typeof st[k] === "string" && /^#[0-9a-f]{6}$/i.test(st[k])) out.style[k] = st[k];
  if (typeof st.ringWidth === "number" && Number.isFinite(st.ringWidth)) out.style.ringWidth = Math.min(10, Math.max(0, st.ringWidth));
  if (typeof st.bgTransparent === "boolean") out.style.bgTransparent = st.bgTransparent;
  if (typeof st.customFrame === "string") out.style.customFrame = st.customFrame.slice(0, 4096);
  if ([256, 512, 1024].includes(Number(st.size))) out.style.size = Number(st.size);
  if (typeof st.folder === "string" && st.folder.length < 512 && !/(^|\/)\.\.(\/|$)/.test(st.folder.replaceAll("\\", "/"))) out.style.folder = st.folder;
  if (typeof st.applyToken === "boolean") out.style.applyToken = st.applyToken;
  if (typeof st.applyPortrait === "boolean") out.style.applyPortrait = st.applyPortrait;
  return out;
}

/** Local-only backup; no game data or token images are modified. */
function downloadBackup(actor, state) {
  const payload = {
    format: "token-atelier-actor-backup", schema: 1,
    createdAt: new Date().toISOString(), actorId: actor.id, actorName: actor.name,
    data: foundry.utils.deepClone(state)
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `token-atelier-backup-${slug(actor.name)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Deferred to avoid cancelling downloads in Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
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
    this._saveChain = Promise.resolve();
    this._exporting = false;
    this._importing = false;
    this._selectedPresetId = "";
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
      "bulk-folder": TokenAtelierApp.onBulkFolder,
      "bulk-upload": TokenAtelierApp.onBulkUpload,
      "add-portrait": TokenAtelierApp.onAddPortrait,
      "remove-art": TokenAtelierApp.onRemoveArt,
      "pick-frame": TokenAtelierApp.onPickFrame,
      "set-shared": TokenAtelierApp.onSetShared,
      "reset": TokenAtelierApp.onReset,
      "preset-save": TokenAtelierApp.onSavePreset,
      "preset-apply": TokenAtelierApp.onApplyPreset,
      "preset-delete": TokenAtelierApp.onDeletePreset,
      "backup-download": TokenAtelierApp.onBackupDownload,
      "backup-restore": TokenAtelierApp.onBackupRestore,
      "export-all": TokenAtelierApp.onExportAll,
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
      presets: getBorderPresets().map(p => ({...p, selected: p.id === this._selectedPresetId})),
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
    this._saveTimer = setTimeout(() => { void this._save().catch(() => {}); }, 500);
  }

  async _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!isGM() || !this.actor.isOwner) return;
    // Serialize writes so a delayed older write cannot overwrite the latest state.
    const snapshot = foundry.utils.deepClone(this.atelierData);
    this._saveChain = this._saveChain.catch(() => {}).then(() => this.actor.setFlag(MOD, "data", snapshot));
    try { await this._saveChain; }
    catch (err) {
      console.error(`${MOD} | Could not save state`, err);
      ui.notifications.error("Token Atelier: token settings could not be saved. Check F12 Console.");
      throw err;
    }
  }

  async close(options) {
    if (this._saveTimer) await this._save();
    await this._saveChain;
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

    // Global border preset selection is not part of the actor's settings.
    const presetList = root.querySelector('[name="borderPreset"]');
    if (presetList) presetList.addEventListener("change", ev => { this._selectedPresetId = ev.currentTarget.value; });
    const bulkFilesInput = root.querySelector('[name="bulkArtFiles"]');
    if (bulkFilesInput) bulkFilesInput.addEventListener("change", async ev => {
      const input = ev.currentTarget;
      const files = Array.from(input.files || []);
      input.value = "";
      if (files.length) await this._bulkUploadFiles(files);
    });

    const restoreInput = root.querySelector('[name="restoreBackupFile"]');
    if (restoreInput) restoreInput.addEventListener("change", async ev => {
      const file = ev.currentTarget.files?.[0];
      ev.currentTarget.value = "";
      if (file) await this._restoreBackup(file);
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

  /** Import every supported image in ONE selected Foundry Data folder. No uploads. */
  static onBulkFolder() {
    if (!isGM() || !this.actor.isOwner) return;
    if (this._importing) return ui.notifications.warn("Token Atelier: an import is already running.");
    const FP = filePicker();
    new FP({
      type: "folder", activeSource: "data",
      callback: folder => { void this._bulkImportFolder(folder); }
    }).browse().catch(err => {
      console.error(`${MOD} | Bulk folder picker failed`, err);
      ui.notifications.error("Token Atelier: could not open the folder browser.");
    });
  }

  /** Choose multiple local pictures using a native multiple-file input. */
  static onBulkUpload() {
    if (!isGM() || !this.actor.isOwner) return;
    if (this._importing) return ui.notifications.warn("Token Atelier: an import is already running.");
    if (!game.user.can("FILES_UPLOAD")) return ui.notifications.error("Token Atelier: file upload permission is required.");
    this.element.querySelector('[name="bulkArtFiles"]')?.click();
  }

  /** Append once, save once, and retain the selected art and every saved alignment. */
  async _appendBulkArts(paths, details = "") {
    if (!isGM() || !this.actor.isOwner) return;
    const plan = planArtImport(paths, this.atelierData.arts);
    if (!plan.accepted.length) {
      ui.notifications.warn(`Token Atelier: no new images imported (${plan.skipped} duplicates, ${plan.invalid} unsupported, ${plan.overLimit} over limit).`);
      return plan;
    }
    const beforeArts = this.atelierData.arts;
    const beforeActive = this.atelierData.active;
    const added = plan.accepted.map(src => ({
      id: foundry.utils.randomID(), src, label: baseName(src), linked: true, tf: { ...DEFAULT_TF }
    }));
    this.atelierData.arts = [...beforeArts, ...added];
    if (!this.atelierData.active) this.atelierData.active = added[0].id;
    try {
      await this._save();
    } catch (err) {
      this.atelierData.arts = beforeArts;
      this.atelierData.active = beforeActive;
      throw err;
    }
    await this.render({ force: true });
    ui.notifications.info(`Token Atelier: imported ${added.length} art(s)${details ? ` ${details}` : ""}; skipped ${plan.skipped} duplicate(s), ${plan.invalid} unsupported, ${plan.overLimit} over limit.`);
    return plan;
  }

  async _bulkImportFolder(folder) {
    if (!isGM() || !this.actor.isOwner) return;
    if (this._importing) return ui.notifications.warn("Token Atelier: an import is already running.");
    if (typeof folder !== "string" || !folder.trim() || /(^|\/)\.\.(\/|$)/.test(folder.replaceAll("\\", "/"))) {
      return ui.notifications.error("Token Atelier: invalid source folder.");
    }
    this._importing = true;
    try {
      const result = await filePicker().browse("data", folder, {});
      if (!Array.isArray(result?.files)) throw new Error("Folder could not be listed");
      // Only direct children, not subfolders. Sorting makes bulk import repeatable.
      const paths = result.files.filter(path => typeof path === "string" && isImportableImage(path))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
      const unsupported = result.files.length - paths.length;
      const plan = await this._appendBulkArts(paths, `from ${folder}`);
      if (unsupported) ui.notifications.info(`Token Atelier: ${unsupported} non-image file(s) ignored in the folder.`);
      return plan;
    } catch (err) {
      console.error(`${MOD} | Folder bulk import failed`, err);
      ui.notifications.error("Token Atelier: folder import failed. Existing art was kept. Check F12 Console.");
    } finally { this._importing = false; }
  }

  async _bulkUploadFiles(files) {
    if (!isGM() || !this.actor.isOwner) return;
    if (this._importing) return ui.notifications.warn("Token Atelier: an import is already running.");
    if (!game.user.can("FILES_UPLOAD")) return ui.notifications.error("Token Atelier: file upload permission is required.");
    this._importing = true;
    try {
      const supported = files.filter(file => isImportableImage(file?.name));
      const invalid = files.length - supported.length;
      const availableSlots = MAX_ARTS_PER_ACTOR - this.atelierData.arts.length;
      if (availableSlots <= 0) return ui.notifications.warn("Token Atelier: this actor already has the maximum of 250 images.");
      // This lives under the output folder, but never mixes source art with exported token PNGs.
      const base = (this.atelierData.style.folder || "").trim().replace(/^\/+|\/+$/g, "") || "token-atelier";
      const folder = `${base}/source-art/${slug(this.actor.name, "actor")}-${this.actor.id}`;
      if (/(^|\/)\.\.(\/|$)/.test(folder.replaceAll("\\", "/"))) throw new Error("Invalid upload folder");
      await ensureFolder(folder);
      // Fail closed on missing folder access so nothing is accidentally overwritten.
      const existing = await existingFilenames(folder);
      const alreadyImported = new Set(this.atelierData.arts.map(a => artSourceKey(a.src)));
      const paths = [];
      const failures = [];
      let skipped = 0;
      const room = Math.max(0, MAX_ARTS_PER_ACTOR - this.atelierData.arts.length);
      for (const file of supported) {
        if (paths.length >= room) break;
        // Re-selecting an already imported source filename doesn't create duplicates.
        const original = imageFilename(file.name);
        const ext = original.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
        const normalizedName = `${slug(original.slice(0, -(ext.length + 1)), "image").slice(0, 95)}.${ext}`;
        const expectedPath = `${folder}/${normalizedName}`;
        if (alreadyImported.has(artSourceKey(expectedPath))) { skipped++; continue; }
        try {
          const safeName = uniqueImageFilename(file.name, existing);
          const uploadFile = safeName === file.name ? file : new File([file], safeName, { type: file.type || "application/octet-stream" });
          const response = await filePicker().upload("data", folder, uploadFile, {}, { notify: false });
          if (!response?.path) throw new Error(`No upload path returned for ${safeName}`);
          paths.push(response.path);
          alreadyImported.add(artSourceKey(response.path));
        } catch (err) {
          console.error(`${MOD} | Could not upload ${file.name}`, err);
          failures.push(file.name);
        }
      }
      if (paths.length) await this._appendBulkArts(paths, `from your computer`);
      else ui.notifications.warn("Token Atelier: no new images were uploaded.");
      if (failures.length || invalid || skipped || supported.length > room) {
        ui.notifications.warn(`Token Atelier: skipped ${invalid} unsupported, ${skipped} already imported, ${Math.max(0, supported.length - room)} over limit; ${failures.length} upload(s) failed.`);
      }
    } catch (err) {
      console.error(`${MOD} | Bulk upload failed`, err);
      ui.notifications.error("Token Atelier: bulk upload failed. Existing art was kept. Check F12 Console.");
    } finally { this._importing = false; }
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

  static async onSavePreset() {
    if (!isGM()) return;
    const name = this.element.querySelector('[name="presetName"]')?.value.trim();
    if (!name || name.length > 70) {
      ui.notifications.warn("Token Atelier: enter a preset name (1–70 characters).");
      return;
    }
    const presets = getBorderPresets();
    if (presets.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      ui.notifications.warn("Token Atelier: a preset with that name already exists. Choose a different name.");
      return;
    }
    const id = foundry.utils.randomID();
    try {
      await game.settings.set(MOD, "borderPresets", [...presets, { id, name, style: borderStyle(this.atelierData.style) }]);
      this._selectedPresetId = id;
      await this.render({ force: true });
      ui.notifications.info(`Token Atelier: saved border preset "${name}".`);
    } catch (err) {
      console.error(`${MOD} | Preset save failed`, err);
      ui.notifications.error("Token Atelier: could not save border preset.");
    }
  }

  static async onApplyPreset() {
    if (!isGM()) return;
    const preset = getBorderPresets().find(p => p.id === this._selectedPresetId);
    if (!preset) return ui.notifications.warn("Token Atelier: select a preset first.");
    const defaults = defaultState().style;
    // Only visual settings change: leave export size, folder, save flags, art and alignments unchanged.
    for (const key of PRESET_STYLE_KEYS) {
      if (Object.hasOwn(preset.style, key)) this.atelierData.style[key] = foundry.utils.deepClone(preset.style[key]);
      else this.atelierData.style[key] = defaults[key];
    }
    await this._save();
    await this.render({ force: true });
    ui.notifications.info(`Token Atelier: applied preset "${preset.name}".`);
  }

  static async onDeletePreset() {
    if (!isGM()) return;
    const preset = getBorderPresets().find(p => p.id === this._selectedPresetId);
    if (!preset) return ui.notifications.warn("Token Atelier: select a preset first.");
    if (!window.confirm(`Delete border preset "${preset.name}"? Existing token designs will not change.`)) return;
    try {
      await game.settings.set(MOD, "borderPresets", getBorderPresets().filter(p => p.id !== preset.id));
      this._selectedPresetId = "";
      await this.render({ force: true });
      ui.notifications.info("Token Atelier: preset deleted (actor designs were not changed).");
    } catch (err) {
      console.error(`${MOD} | Preset deletion failed`, err);
      ui.notifications.error("Token Atelier: could not delete the preset.");
    }
  }

  static onBackupDownload() {
    if (!isGM() || !this.actor.isOwner) return;
    downloadBackup(this.actor, this.atelierData);
    ui.notifications.info("Token Atelier: token settings backup downloaded as JSON.");
  }

  static onBackupRestore() {
    if (!isGM() || !this.actor.isOwner) return;
    this.element.querySelector('[name="restoreBackupFile"]')?.click();
  }

  async _restoreBackup(file) {
    if (!isGM() || !this.actor.isOwner) return;
    try {
      if (file.size > 2_000_000) throw new Error("Backup exceeds 2MB safety limit");
      const payload = JSON.parse(await file.text());
      if (payload?.format !== "token-atelier-actor-backup" || payload.schema !== 1) throw new Error("Not a Token Atelier actor backup");
      const restored = restoredActorData(payload.data);
      const from = payload.actorName || "unknown actor";
      if (!window.confirm(`Restore Token Atelier settings from "${from}" to "${this.actor.name}"?\nYour current design will first be downloaded as a safety backup. The token PNG and portrait will not be changed.`)) return;
      // Download the current design BEFORE overwriting actor flags. Abort if backup fails.
      downloadBackup(this.actor, this.atelierData);
      this.atelierData = restored;
      try { await this._save(); }
      catch (err) { this.atelierData = loadState(this.actor); throw err; }
      await this.render({ force: true });
      ui.notifications.info("Token Atelier: settings restored. Previous settings downloaded as a backup.");
    } catch (err) {
      console.error(`${MOD} | Backup restore failed`, err);
      ui.notifications.error(`Token Atelier: restore failed (${err.message}). Current settings were not intentionally replaced.`);
    }
  }

  static async onExportAll() { await this._exportAll(); }

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

  _paintArt(ctx, S, st, image = this._img, tf = this.tf) {
    if (!st.bgTransparent) {
      ctx.fillStyle = st.bgColor;
      ctx.fillRect(0, 0, S, S);
    }
    if (!image) return;
    const w = tf.scale * S;
    const h = w * (image.naturalHeight / image.naturalWidth);
    ctx.save();
    ctx.translate(S / 2 + tf.ox * S, S / 2 + tf.oy * S);
    ctx.rotate((tf.rot * Math.PI) / 180);
    ctx.drawImage(image, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  _draw(canvas = this.canvas, image = this._img, tf = this.tf) {
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
      this._paintArt(lctx, S, st, image, tf);
      lctx.globalCompositeOperation = "destination-in";
      lctx.drawImage(this._frameMask, 0, 0);
      lctx.globalCompositeOperation = "source-over";
      ctx.drawImage(layer, 0, 0);
    } else {
      ctx.save();
      this._maskPath(ctx, S, st.mask);
      ctx.clip();
      this._paintArt(ctx, S, st, image, tf);
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

  /** Save an image to Foundry without overwriting an existing filename. */
  async _uploadToken(blob, folder, stem, usedNames) {
    const name = nextAvailableName(stem, usedNames);
    const file = new File([blob], name, { type: "image/png" });
    const response = await filePicker().upload("data", folder, file, {}, { notify: false });
    if (!response?.path) throw new Error(`Upload returned no path for ${name}`);
    return response.path;
  }

  async _pngBlob(canvas) {
    return new Promise((resolve, reject) => {
      try { canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Empty image"))), "image/png"); }
      catch (err) { reject(err); }
    });
  }

  async _export() {
    if (this._exporting) return ui.notifications.warn("Token Atelier: another export is already running.");
    if (!isGM() || !this.actor.isOwner) return ui.notifications.warn("Token Atelier is for Game Masters only.");
    const art = this.art;
    if (!art || !this._img) return ui.notifications.warn("Token Atelier: add and select some art first.");
    if (!game.user.can("FILES_UPLOAD")) return ui.notifications.error("Token Atelier: file upload permission is required.");

    this._exporting = true;
    try {
      const st = this.atelierData.style;
      const folder = (st.folder || "").trim().replace(/^\/+|\/+$/g, "") || "token-atelier";
      await ensureFolder(folder);
      const usedNames = await existingFilenames(folder);
      this._draw();
      const blob = await this._pngBlob(this.canvas);
      const stem = `${slug(this.actor.name, "actor")}-${slug(art.label, "art")}`;
      const path = await this._uploadToken(blob, folder, stem, usedNames);
      const update = {};
      if (st.applyToken) update["prototypeToken.texture.src"] = path;
      if (st.applyPortrait) update.img = path;
      if (Object.keys(update).length) await this.actor.update(update);
      await this._save();
      ui.notifications.info(`Token Atelier: safely saved ${path}`);
    } catch (err) {
      console.error(`${MOD} | Single export failed`, err);
      ui.notifications.error("Token Atelier: save failed (no existing files intentionally overwritten). Check F12 Console.");
    } finally {
      this._exporting = false;
    }
  }

  /** Export all art variants; never change the actor's portrait, token or active art. */
  async _exportAll() {
    if (this._exporting) return ui.notifications.warn("Token Atelier: another export is already running.");
    if (!isGM() || !this.actor.isOwner) return ui.notifications.warn("Token Atelier is for Game Masters only.");
    if (!game.user.can("FILES_UPLOAD")) return ui.notifications.error("Token Atelier: file upload permission is required.");
    const arts = [...this.atelierData.arts];
    if (!arts.length) return ui.notifications.warn("Token Atelier: add some art first.");
    this._exporting = true;
    try {
    const st = this.atelierData.style;
    const folder = (st.folder || "").trim().replace(/^\/+|\/+$/g, "") || "token-atelier";
    let usedNames;
    try {
      await ensureFolder(folder);
      usedNames = await existingFilenames(folder);
    } catch (err) {
      console.error(`${MOD} | Could not check existing files`, err);
      return ui.notifications.error("Token Atelier: cannot inspect destination folder. Batch export stopped to protect existing files.");
    }

    const temp = document.createElement("canvas");
    temp.width = temp.height = this.canvas.width;
    let saved = 0;
    const failures = [];
    for (const art of arts) {
      try {
        const image = await loadImage(art.src);
        const tf = art.linked ? this.atelierData.shared : art.tf;
        this._draw(temp, image, tf);
        const blob = await this._pngBlob(temp);
        await this._uploadToken(blob, folder, `${slug(this.actor.name, "actor")}-${slug(art.label, "art")}`, usedNames);
        saved++;
      } catch (err) {
        failures.push(art.label);
        console.error(`${MOD} | Batch export failed for ${art.label}`, err);
      }
    }
    // No actor.update: batch export is deliberately non-destructive.
    if (failures.length) ui.notifications.warn(`Token Atelier: exported ${saved}/${arts.length}. Failed: ${failures.slice(0, 5).join(", ")}. See Console.`);
    else ui.notifications.info(`Token Atelier: exported all ${saved} images safely to ${folder}. Actor token was not changed.`);
    } finally {
      this._exporting = false;
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
  game.settings.register(MOD, "borderPresets", {
    name: "Shared border presets",
    hint: "GM-managed border templates shared in this world.",
    scope: "world",
    config: false,
    type: Array,
    default: []
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
