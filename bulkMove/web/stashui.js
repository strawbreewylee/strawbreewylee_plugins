// SPDX-License-Identifier: MIT
// Bulk Move for Stash UI  (Extension API v2: assets/stashui.js, default export = setup(stashui))
//
// Adds "Move to folder…" to the selection bar of the SCENE, IMAGE and GALLERY lists (a zip/cbz gallery = the archive file). It uses ONLY Stash's native
// `moveFiles` GraphQL mutation – the same code path as Stash's own "Move files" – so the database
// and the filesystem change together. It never touches the filesystem itself and never falls back
// to anything else when a move fails.
//
// Behaviour of moveFiles that this module relies on (re-confirm against your Stash version):
//   * takes FILE ids (not scene/image ids): moveFiles(input: { ids, destination_folder })
//   * destination_folder must be inside a configured library path, else the call fails
//   * missing destination folders are created; files keep their basename and their file id
//   * a name clash fails with "file <path> already exists"; nothing is overwritten
//   * ONE call is ATOMIC: if any file in `ids` fails, every file of that call is rolled back
//     (database and disk, and newly created folders). So this module sends one call PER FILE,
//     which makes "moved" and "failed" exact, and it never retries.
//   * it does NOT move sidecar files (.funscript, .srt/.vtt) that lie next to a video.
//
// Safety additions: refuses to start while a scan / clean / generate (etc.) job runs unless the user
// explicitly overrides; a running batch can be stopped (button, or closing the drawer) and stops after
// the current file; the tab warns before it is closed during a batch; warns when Watchtower is installed.

// ---------------------------------------------------------------------------------------------
// Pure logic (no DOM) – exported so it can be tested on its own
// ---------------------------------------------------------------------------------------------

const FILE_FIELDS = `id path basename size parent_folder { id path } zip_file { id }`;
// Galleries: a zip/cbz gallery owns the archive file (`files`); a folder-based gallery has a `folder` and no file.
const GALLERY_FIELDS = `id title folder { id path } files { ${FILE_FIELDS} }`;
const SCENE_FIELDS = `id title interactive captions { language_code caption_type } files { ${FILE_FIELDS} }`;
// Images: current Stash has `visual_files` (ImageFile | VideoFile); older versions only `files`.
const imageFields = (legacy) => (legacy
  ? `id title galleries { id } files { ${FILE_FIELDS} }`
  : `id title galleries { id } visual_files { ... on ImageFile { ${FILE_FIELDS} } ... on VideoFile { ${FILE_FIELDS} } }`);

const Q_SCENES = `query($ids: [ID!]) { findScenes(ids: $ids, filter: { per_page: -1 }) { scenes { ${SCENE_FIELDS} } } }`;
const Q_SCENE = `query($id: ID) { findScene(id: $id) { ${SCENE_FIELDS} } }`;
const Q_LIBS = `{ configuration { general { stashes { path } } } }`;
const Q_DIR = `query($p: String) { directory(path: $p) { path parent directories } }`;
const Q_IN_DIR = `query($f: FileFilterType) { findFiles(file_filter: $f, filter: { per_page: -1 }) { files { id path basename } } }`;
const Q_FOLDER = `query($f: FolderFilterType) { findFolders(folder_filter: $f) { count } }`;
const Q_FILES = `query($ids: [ID!]) { findFiles(ids: $ids, filter: { per_page: -1 }) { files { id path } } }`;
const Q_JOBS = `{ jobQueue { id status description } }`;
const Q_PLUGINS = `{ plugins { id name enabled } }`;
const M_MOVE = `mutation($i: MoveFilesInput!) { moveFiles(input: $i) }`;

// Every call is "raw": Stash UI must not rewrite these queries (it injects hidden-folder filters into findScenes).
const RAW = { raw: true };

export const detectSep = (...paths) => (paths.some((p) => /\\/.test(p || "")) && !paths.some((p) => /\//.test(p || "")) ? "\\" : "/");

// "  /data/videos//Sorted/ " -> "/data/videos/Sorted" (roots stay "/" or "C:\"; UNC \\server\share is kept)
export function normDir(p, sep) {
  let s = String(p || "").trim();
  if (!s) return "";
  const unc = sep === "\\" && s.startsWith("\\\\");
  const re = sep === "\\" ? /\\+/g : /\/+/g;
  s = s.replace(re, sep);
  if (unc) s = "\\" + s;
  if (s.length > 1 && s.endsWith(sep) && !/^[A-Za-z]:\\$/.test(s)) s = s.slice(0, -1);
  return s;
}

// Breadcrumb parts of an absolute path: "/data/videos/a" -> [{label:"data",path:"/data"}, {label:"videos",path:"/data/videos"}, ...]
export function crumbs(path, sep) {
  const unc = sep === "\\" && String(path).startsWith("\\\\");
  const out = [];
  let cur = "";
  String(path).split(sep).filter(Boolean).forEach((part, i) => {
    if (i === 0) cur = unc ? "\\\\" + part : sep === "/" ? "/" + part : part + sep; // "/data", "\\\\server", "C:\\"
    else cur = cur.endsWith(sep) ? cur + part : cur + sep + part;
    out.push({ label: part, path: cur });
  });
  return out;
}

export const joinPath = (dir, name, sep) => (dir.endsWith(sep) ? dir + name : dir + sep + name);
const keyOf = (p, sep) => (sep === "\\" ? p.toLowerCase() : p); // Windows paths are case-insensitive

// Is `dir` equal to, or inside, one of the library paths? (same rule Stash applies on the server)
export function inLibrary(dir, libraries, sep) {
  const d = keyOf(dir, sep);
  return libraries.some((l) => {
    const root = keyOf(normDir(l, sep), sep);
    return d === root || d.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

export const isAbsolute = (p) => p.startsWith("/") || /^[A-Za-z]:\\/.test(p) || p.startsWith("\\\\");

export const nounOf = (kind) => (kind === "image" ? "image" : kind === "gallery" ? "gallery" : "scene");
export const nounS = (kind) => (kind === "gallery" ? "gallery(ies)" : `${nounOf(kind)}(s)`); // "scene(s)", "gallery(ies)"
export const nounPl = (kind) => (kind === "gallery" ? "galleries" : `${nounOf(kind)}s`);

const isFieldError = (e) => /cannot query field|unknown field/i.test(String((e && e.message) || e));

// Scenes, images and galleries become the same shape: { id, title, files[], interactive, captions[], inGallery, hasFolder, kind }
export function normalizeItem(kind, raw) {
  const files = (kind === "image" ? raw.visual_files || raw.files || [] : raw.files || []).filter((f) => f && f.id && f.path);
  return {
    id: String(raw.id), title: raw.title || "", files, kind,
    interactive: !!raw.interactive, captions: raw.captions || [],
    inGallery: !!(raw.galleries && raw.galleries.length),
    hasFolder: !!raw.folder, // folder-based gallery
  };
}

// Resolve ids of scenes or images. A missing id makes findScenes/findImages fail as a whole, so on error we ask one by one
// and report exactly which ids do not exist. Returns { scenes (the items, in the order given), missing }.
export async function resolveItems(gql, rawIds, kind = "scene") {
  const ids = [...new Set(rawIds.map(String))];
  const byId = new Map();
  let legacy = false;
  const spec = () => {
    if (kind === "image") {
      return {
        many: `query($ids: [ID!]) { findImages(ids: $ids, filter: { per_page: -1 }) { images { ${imageFields(legacy)} } } }`,
        one: `query($id: ID) { findImage(id: $id) { ${imageFields(legacy)} } }`,
        pick: (d) => d.findImages.images, pickOne: (d) => d.findImage,
      };
    }
    if (kind === "gallery") {
      return {
        many: `query($ids: [ID!]) { findGalleries(ids: $ids, filter: { per_page: -1 }) { galleries { ${GALLERY_FIELDS} } } }`,
        one: `query($id: ID!) { findGallery(id: $id) { ${GALLERY_FIELDS} } }`,
        pick: (d) => d.findGalleries.galleries, pickOne: (d) => d.findGallery,
      };
    }
    return { many: Q_SCENES, one: Q_SCENE, pick: (d) => d.findScenes.scenes, pickOne: (d) => d.findScene };
  };
  const add = (raw) => { const it = normalizeItem(kind, raw); byId.set(it.id, it); };
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    for (let attempt = 0; attempt < 2; attempt++) {
      const sp = spec();
      try {
        sp.pick(await gql(sp.many, { ids: chunk }, RAW)).forEach(add);
        break;
      } catch (e) {
        if (kind === "image" && !legacy && isFieldError(e)) { legacy = true; continue; } // older Stash: retry with `files`
        for (const id of chunk) { // a real error (network, auth) still throws here
          const o = sp.pickOne(await gql(sp.one, { id }, RAW));
          if (o) add(o);
        }
        break;
      }
    }
  }
  return { scenes: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)), missing: ids.filter((id) => !byId.has(id)) };
}
export const resolveScenes = (gql, rawIds) => resolveItems(gql, rawIds, "scene");

// Build the move plan. Nothing is executed here.
//   mode: "all"     – every file of every selected item (a scene/image can have several files)
//         "primary" – only the first (primary) file of each item; the others stay where they are
//   existing: files Stash already knows in the destination folder [{ basename }]
// Row status: "move" | "same" (already there) | "conflict" (never overwritten) | "zip" (cannot move) | "nofile" (item has no file) | "folder" (folder-based gallery) | "left" (not selected by mode)
export function buildPlan({ scenes, destination, mode, existing, libraries, folderKnown, kind = "scene" }) {
  const noun = nounOf(kind);
  const ns = nounS(kind);
  const sample = [destination, ...libraries, ...scenes.flatMap((s) => s.files.map((f) => f.path))];
  const sep = detectSep(...sample);
  const dest = normDir(destination, sep);
  const plan = { destination: dest, sep, mode, kind, rows: [], warnings: [], error: null, folderKnown: !!folderKnown };

  if (!dest) plan.error = "Enter a destination folder.";
  else if (!isAbsolute(dest)) plan.error = "The destination must be an absolute path, as Stash sees it.";
  else if (!inLibrary(dest, libraries, sep)) plan.error = "Stash only moves files into its library folders. This path is outside all of them (check Settings → Library).";

  const taken = new Map(); // lower-cased target path -> source path (files that will really move)
  const there = new Set((existing || []).map((f) => keyOf(joinPath(dest, f.basename, sep), sep)));
  let splitItems = 0;
  let sidecarItems = 0;
  let galleryItems = 0;
  let archiveCount = 0;

  for (const s of scenes) {
    const label = s.title || (s.files[0] && s.files[0].basename) || `${noun[0].toUpperCase() + noun.slice(1)} ${s.id}`;
    let skipped = 0;
    if (!s.files.length) {
      const folderGallery = kind === "gallery" && s.hasFolder;
      plan.rows.push({ sceneId: s.id, sceneTitle: label, status: folderGallery ? "folder" : "nofile", path: "", basename: "", dir: "", size: 0,
        reason: folderGallery ? "folder-based gallery – Stash moves files, not folders" : `this ${noun} has no file` });
    }
    s.files.forEach((f, i) => {
      const row = {
        sceneId: s.id, sceneTitle: label, fileId: f.id, path: f.path, basename: f.basename, size: f.size || 0,
        dir: normDir(f.parent_folder ? f.parent_folder.path : f.path.slice(0, f.path.length - f.basename.length), sep),
        primary: i === 0, status: "move", reason: "", newPath: joinPath(dest, f.basename, sep),
      };
      if (mode === "primary" && i > 0) { row.status = "left"; row.reason = "extra file – stays where it is"; }
      else if (f.zip_file) { row.status = "zip"; row.reason = "inside a zip archive – Stash cannot move it"; }
      else if (keyOf(row.dir, sep) === keyOf(dest, sep)) { row.status = "same"; row.reason = "already in the destination"; }
      else if (there.has(keyOf(row.newPath, sep))) { row.status = "conflict"; row.reason = "a file with this name already exists in the destination"; }
      else if (taken.has(keyOf(row.newPath, sep))) { row.status = "conflict"; row.reason = `same file name as another selected file (${taken.get(keyOf(row.newPath, sep))})`; }
      else taken.set(keyOf(row.newPath, sep), f.path);
      if (row.status !== "move" && row.status !== "left" && row.status !== "same") skipped++;
      plan.rows.push(row);
    });
    if (skipped && skipped < s.files.length && mode === "all") splitItems++;
    if (s.interactive || (s.captions && s.captions.length)) sidecarItems++;
    if (s.inGallery) galleryItems++;
    if (kind === "gallery" && s.files.length) archiveCount++;
  }

  if (splitItems) plan.warnings.push(`${splitItems} ${ns} will end up with their files in different folders because some files are skipped.`);
  if (sidecarItems) plan.warnings.push(`${sidecarItems} scene(s) have a funscript or captions. Stash moves only the video; those side files next to it stay behind and must be moved by hand, or the scene loses them.`);
  if (galleryItems) plan.warnings.push(`${galleryItems} image(s) belong to a gallery. Moving the file out of the gallery's folder may change that membership; check the gallery afterwards. If "create galleries from folders" is on, a later scan may also create a gallery for the destination folder.`);
  if (archiveCount) plan.warnings.push(`${archiveCount} archive(s): every image inside moves with its zip. Stash derives the contained images' paths from the archive, so this should follow automatically, but open one of these galleries afterwards to check it still loads. If images look missing, scan the destination folder. Only .zip / .cbz archives are known to Stash.`);
  if (!plan.error && !folderKnown) plan.warnings.push("This folder is not known to Stash yet. Stash creates it (and any missing parent folders).");

  const mv = plan.rows.filter((r) => r.status === "move");
  plan.summary = {
    scenes: scenes.length,
    move: mv.length,
    bytes: mv.reduce((n, r) => n + r.size, 0),
    same: plan.rows.filter((r) => r.status === "same").length,
    conflict: plan.rows.filter((r) => r.status === "conflict").length,
    zip: plan.rows.filter((r) => r.status === "zip").length,
    nofile: plan.rows.filter((r) => r.status === "nofile").length,
    folder: plan.rows.filter((r) => r.status === "folder").length,
    left: plan.rows.filter((r) => r.status === "left").length,
  };
  return plan;
}

export async function loadLibraries(gql) {
  const d = await gql(Q_LIBS, {}, RAW);
  return d.configuration.general.stashes.map((s) => s.path);
}

export async function listDir(gql, path) {
  const d = await gql(Q_DIR, { p: path }, RAW);
  return d.directory;
}

// What does Stash already know in the destination? (advisory; the server's own check at move time is the real guard –
// it also catches files on disk that Stash has not scanned.)
export async function probeDestination(gql, dest) {
  const eq = (value) => ({ value, modifier: "EQUALS" });
  const [files, folder] = await Promise.all([
    gql(Q_IN_DIR, { f: { dir: eq(dest) } }, RAW),
    gql(Q_FOLDER, { f: { path: eq(dest) } }, RAW),
  ]);
  return { existing: files.findFiles.files, folderKnown: folder.findFolders.count > 0 };
}

// --- running jobs ------------------------------------------------------------------------------
// Job descriptions are free text, so this is a heuristic: jobs that scan, clean, generate, tag, identify, import/export,
// migrate, optimise or back up the database/library BLOCK; any other active job only produces a note.
// (Watchtower may keep a long-lived job of its own in the queue; that must not block moves forever.)
const BLOCKING_JOB = /scan|clean|generat|auto.?tag|identif|import|export|migrat|optimi[sz]|backup|anonymi[sz]/i;
const ACTIVE_STATUS = /^(READY|RUNNING|FINISHING|STOPPING)$/i;

export function classifyJobs(jobs) {
  const active = (jobs || []).filter((j) => j && ACTIVE_STATUS.test(String(j.status)));
  return {
    blocking: active.filter((j) => BLOCKING_JOB.test(j.description || "")),
    other: active.filter((j) => !BLOCKING_JOB.test(j.description || "")),
  };
}

export async function checkJobs(gql) {
  const d = await gql(Q_JOBS, {}, RAW);
  return classifyJobs(d.jobQueue);
}

export async function detectWatchtower(gql) {
  try {
    const d = await gql(Q_PLUGINS, {}, RAW);
    return d.plugins.some((p) => /watchtower|librarymanager/i.test(`${p.id} ${p.name}`) && p.enabled !== false);
  } catch (e) { return false; }
}

export const WATCHTOWER_WARNING = "Watchtower is installed. Its file monitor and automatic renaming may react to these moves (and could rename or move files again). Consider pausing its monitoring and auto-rename for the duration of the batch.";

// One moveFiles call per file. Each call is atomic on the server, so a failure leaves that file exactly where it was.
// No retries: a failed move is reported, never repeated. If shouldStop() turns true, the file being moved is finished
// and the remaining files are returned as { skipped: true } (never attempted).
export async function executePlan(gql, plan, onProgress, shouldStop) {
  const todo = plan.rows.filter((r) => r.status === "move");
  const results = [];
  for (let i = 0; i < todo.length; i++) {
    const row = todo[i];
    if (shouldStop && shouldStop()) {
      for (let j = i; j < todo.length; j++) results.push({ row: todo[j], ok: false, skipped: true, error: "not attempted (stopped)" });
      break;
    }
    onProgress && onProgress(i, todo.length, row);
    try {
      const d = await gql(M_MOVE, { i: { ids: [String(row.fileId)], destination_folder: plan.destination } }, RAW);
      results.push({ row, ok: d.moveFiles === true, error: d.moveFiles === true ? null : "Stash answered false" });
    } catch (e) {
      results.push({ row, ok: false, error: String((e && e.message) || e) });
    }
  }
  onProgress && onProgress(todo.length, todo.length, null);
  return results;
}

// Ask Stash again where every file is now, and compare with what was expected (same case rule as the planner).
export async function verifyResults(gql, results, sep = "/") {
  const now = new Map();
  for (let i = 0; i < results.length; i += 200) {
    const ids = results.slice(i, i + 200).map((r) => String(r.row.fileId));
    const d = await gql(Q_FILES, { ids }, RAW);
    d.findFiles.files.forEach((f) => now.set(String(f.id), f.path));
  }
  const same = (a, b) => a != null && keyOf(a, sep) === keyOf(b, sep);
  for (const r of results) {
    r.actual = now.get(String(r.row.fileId)) || null;
    r.verified = r.ok ? same(r.actual, r.row.newPath) : same(r.actual, r.row.path); // failed / not attempted files must still be at the old place
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// UI (only runs inside Stash UI)
// ---------------------------------------------------------------------------------------------

const CSS = `
.kbm{display:flex;flex-direction:column;gap:12px}
.kbm .row{display:flex;gap:8px;align-items:center}.kbm .row .kb-field{flex:1;min-width:0}
.kbm .row .pathbox{flex:1;min-width:0}
.kbm .pathbox{width:100%;box-sizing:border-box;resize:vertical;min-height:2.8em;max-height:160px;padding:8px 10px;font:15px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere;word-break:break-all;border:1px solid var(--line,#555);border-radius:8px;background:transparent;color:inherit}
.kbm .grp{font-size:13px;color:var(--faint,#999);margin:6px 0 0}
.kbm .chips{display:flex;flex-direction:column;gap:6px}
.kbm .chip{display:block;width:100%;text-align:left;cursor:pointer;border:1px solid var(--line,#555);border-radius:8px;padding:7px 10px;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:transparent;color:var(--text-2,inherit);white-space:normal;overflow-wrap:anywhere;word-break:break-all}
.kbm .chip:hover{color:var(--text,inherit);border-color:var(--pink,#c4a)}
.kbm .browser{border:1px solid var(--line,#555);border-radius:8px;font-size:15px}
.kbm .crumbs{padding:8px 10px;font:14px/1.9 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere;border-bottom:1px solid var(--line,#333)}
.kbm .crumbs span{padding:1px 4px;border-radius:4px;cursor:pointer}.kbm .crumbs span:hover{background:var(--bg-2,#222)}
.kbm .crumbs .sepc,.kbm .crumbs .nolink{cursor:default;color:var(--faint,#999);padding:0 1px}.kbm .crumbs .sepc:hover,.kbm .crumbs .nolink:hover{background:none}
.kbm .kbm-filter{width:100%;box-sizing:border-box;padding:7px 10px;font-size:14px;border:0;border-bottom:1px solid var(--line,#333);background:transparent;color:inherit}
.kbm .blist{max-height:40vh;overflow:auto}
.kbm .blist div{padding:8px 10px;cursor:pointer;font-size:15px;line-height:1.4;overflow-wrap:anywhere;word-break:break-word}.kbm .blist div:hover{background:var(--bg-2,#222)}
.kbm .blist .cur{cursor:default;color:var(--faint,#999);font-size:14px}.kbm .blist .cur:hover{background:none}
.kbm .opts label{display:block;font-size:13px;margin:2px 0}
.kbm .tbl{border:1px solid var(--line,#555);border-radius:8px;max-height:36vh;overflow:auto}
.kbm .r{display:flex;gap:8px;padding:7px 10px;border-bottom:1px solid var(--line,#333);font-size:13px;align-items:flex-start}
.kbm .r:last-child{border-bottom:0}.kbm .r .m{flex:1;min-width:0;word-break:break-all}.kbm .r .m small{display:block;font-size:12px;line-height:1.4;color:var(--faint,#999)}
.kbm .tag{font-size:11px;white-space:nowrap;padding:1px 7px;border-radius:999px;border:1px solid var(--line,#555)}
.kbm .ok{color:var(--ok,#6c6)}.kbm .bad{color:var(--danger,#f66)}.kbm .dim{color:var(--faint,#999)}
.kbm .warn{font-size:12px;color:var(--text-2,inherit);margin:0;padding-left:16px}
.kbm .big{font-weight:700}
.kbm .kbm-hint{font-size:12px;color:var(--faint,#999);margin:0}.kbm .kbm-lab{display:block;font-size:14px;margin-bottom:4px}
.kbm .jobs p{margin:0 0 4px;font-size:12px}
.kbm .override{font-size:12px}
`;

const $ = (root, sel) => root.querySelector(sel);

// Local helpers, so the module does not depend on the exact behaviour of ui.esc / ui.fmtBytes
// (esc must escape quotes: it is used inside attribute values).
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtBytes = (n) => {
  n = Number(n) || 0;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + " " + u[i];
};

const MAX_ROWS = 500; // rows drawn in a table; the report always has everything

async function openMove(stashui, ctx, kind) {
  const { ui } = stashui;
  const gql = stashui.gql;
  const noun = nounOf(kind);
  const ns = nounS(kind);
  const nouns = nounPl(kind);
  const ids = ctx.ids().map(String);
  if (!ids.length) return ui.toast(`Select at least one ${noun} first.`, "error");

  if (!document.getElementById("kbm-style")) {
    const st = document.createElement("style");
    st.id = "kbm-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  let alive = true;          // false once the drawer is closed
  let busy = false;          // a batch is running
  let stopRequested = false; // stop after the current file
  const guard = (e) => { e.preventDefault(); e.returnValue = ""; }; // tab close / reload during a batch

  const drawer = ui.openDrawer({
    title: `Move ${nouns} to folder`,
    body: `<div class="kbm">
      <p class="kbm-hint" data-sel>Loading the selected ${nouns}…</p>
      <div>
        <label class="kbm-lab">Destination folder – the path as <b>Stash</b> sees it (inside Docker: the container path)</label>
        <div class="row" style="align-items:flex-start"><textarea class="pathbox" data-dest rows="2" spellcheck="false" autocomplete="off" placeholder="/data/${kind === "scene" ? "videos" : "images"}/Sorted/Studio-A"></textarea><button class="kb-btn" data-browse type="button">Browse</button></div>
      </div>
      <div class="chips" data-chips></div>
      <div class="browser" data-browser hidden>
        <div class="crumbs" data-crumbs></div>
        <input class="kbm-filter" data-filter placeholder="Filter folders…" spellcheck="false" autocomplete="off">
        <div class="blist" data-blist></div>
      </div>
      <div class="opts">
        <label><input type="radio" name="kbm-mode" value="all" checked> All files of each ${noun} (recommended – keeps ${nouns} together)</label>
        <label><input type="radio" name="kbm-mode" value="primary"> Only the primary file of each ${noun}</label>
      </div>
      <div class="jobs" data-jobs></div>
      <label class="override" data-ovl hidden><input type="checkbox" data-override> Move anyway, I know what is running</label>
      <div class="row"><button class="kb-btn" data-preview type="button">Preview</button><span class="kbm-hint" data-state></span></div>
      <div data-out></div>
    </div>`,
    foot: `<button class="kb-btn" data-cancel type="button">Close</button> <button class="kb-btn is-primary" data-go type="button" disabled>Move</button>`,
    onClose: () => { alive = false; if (busy) stopRequested = true; }, // closing mid-move = stop after the current file
  });
  const el = drawer.el;
  const dest = $(el, "[data-dest]");
  const out = $(el, "[data-out]");
  const state = $(el, "[data-state]");
  const go = $(el, "[data-go]");
  const cancel = $(el, "[data-cancel]");
  const jobsBox = $(el, "[data-jobs]");
  const ovl = $(el, "[data-ovl]");
  const override = $(el, "[data-override]");
  const mode = () => el.querySelector('input[name="kbm-mode"]:checked').value;

  // Close = close; while a batch runs it becomes "stop after this file" (the batch is never abandoned silently).
  cancel.onclick = () => {
    if (busy) { stopRequested = true; cancel.disabled = true; cancel.textContent = "Stopping…"; return; }
    drawer.close();
  };

  const show = (html) => { out.innerHTML = html; };
  const fail = (e) => { state.textContent = ""; show(`<p class="bad">${esc(String((e && e.message) || e))}</p>`); };

  // --- load selection + libraries ---
  let scenes = [];
  let libraries = [];
  let plan = null;
  let jobState = null;
  let watchtower = false;
  try {
    const [r, libs, wt] = await Promise.all([resolveItems(gql, ids, kind), loadLibraries(gql), detectWatchtower(gql)]);
    scenes = r.scenes;
    libraries = libs;
    watchtower = wt;
    const nFiles = scenes.reduce((n, s) => n + s.files.length, 0);
    const multi = scenes.filter((s) => s.files.length > 1).length;
    $(el, "[data-sel]").innerHTML = `<b>${scenes.length}</b> ${ns}, <b>${nFiles}</b> file(s)${multi ? ` – ${multi} ${ns} have more than one file` : ""}.` +
      (r.missing.length ? ` <span class="bad">Not found in Stash: ${esc(r.missing.slice(0, 20).join(", "))}${r.missing.length > 20 ? " …" : ""}</span>` : "");
  } catch (e) { return fail(e); }

  // quick picks: library roots and recent destinations (kept separately for scenes and images)
  const recentKey = `recent_${kind}`;
  const recent = stashui.store.get(recentKey, []);
  const chips = $(el, "[data-chips]");
  const addGroup = (title, kindLabel, paths) => {
    if (!paths.length) return;
    const h = document.createElement("div");
    h.className = "grp"; h.textContent = title;
    chips.appendChild(h);
    paths.forEach((p) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.title = kindLabel + ": " + p; b.textContent = p; // full path, wraps
      b.onclick = () => { dest.value = p; invalidate(); };
      chips.appendChild(b);
    });
  };
  addGroup("Recent destinations", "recent", Array.isArray(recent) ? recent : []);
  addGroup("Library folders", "library", libraries);

  // The Move button is enabled only with a valid plan and (when a blocking job runs) an explicit override.
  function refreshGo() {
    const blocked = !!(jobState && jobState.blocking.length && !override.checked);
    go.disabled = busy || !plan || !!plan.error || plan.summary.move === 0 || blocked;
  }
  function grow() { dest.style.height = "auto"; dest.style.height = Math.min(dest.scrollHeight || 0, 160) + "px"; } // show the whole path
  function invalidate() { plan = null; go.textContent = "Move"; state.textContent = ""; grow(); refreshGo(); }
  dest.addEventListener("input", () => { if (/[\r\n]/.test(dest.value)) dest.value = dest.value.replace(/[\r\n]+/g, ""); invalidate(); });
  dest.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const pv = $(el, "[data-preview]"); pv.onclick && pv.onclick(); } });
  el.querySelectorAll('input[name="kbm-mode"]').forEach((r) => r.addEventListener("change", invalidate));
  override.addEventListener("change", refreshGo);

  // Look at the job queue; show what is running. Returns true when moving may go ahead.
  async function jobsAllow() {
    try { jobState = await checkJobs(gql); } catch (e) { jobState = null; }
    const j = jobState;
    const names = (list) => list.map((x) => esc(x.description || x.id)).join(" · ");
    if (!j) jobsBox.innerHTML = `<p class="dim">Could not check for running jobs. Make sure no scan, clean or generate job is running.</p>`;
    else jobsBox.innerHTML =
      (j.blocking.length ? `<p class="bad big">A scan / clean / generate (or similar) job is running: ${names(j.blocking)}. Moving files while it runs can collide with it. Wait until it has finished, or tick “Move anyway”.</p>` : "") +
      (j.other.length ? `<p class="dim">Other active jobs: ${names(j.other)}</p>` : "");
    const blocked = !!(j && j.blocking.length);
    ovl.hidden = !blocked;
    if (!blocked) override.checked = false;
    refreshGo();
    return !blocked || override.checked;
  }

  // --- folder browser (uses Stash's own `directory` query, so paths are the server's paths) ---
  const browser = $(el, "[data-browser]");
  const crumbsBox = $(el, "[data-crumbs]");
  const filterBox = $(el, "[data-filter]");
  const blist = $(el, "[data-blist]");
  let dirs = [];
  let dirSep = "/";
  let dirUp = null;
  const folderName = (p) => p.slice(p.lastIndexOf(dirSep) + 1);
  const enter = (p) => { dest.value = p; invalidate(); browse(p); };
  function drawList() {
    const q = filterBox.value.trim().toLowerCase();
    const shown = q ? dirs.filter((p) => folderName(p).toLowerCase().includes(q)) : dirs;
    blist.innerHTML = (dirUp ? `<div data-p="${esc(dirUp)}">⬆ .. (one level up)</div>` : "") +
      (shown.length ? shown.map((p) => `<div data-p="${esc(p)}">📁 ${esc(folderName(p))}</div>`).join("") : `<div class="cur">${dirs.length ? "No folder matches the filter" : "No subfolders"}</div>`);
    blist.querySelectorAll("[data-p]").forEach((n) => (n.onclick = () => enter(n.dataset.p)));
  }
  filterBox.addEventListener("input", drawList);
  async function browse(path) {
    try {
      const d = await listDir(gql, path);
      dirSep = detectSep(d.path);
      dirUp = d.parent && (inLibrary(d.parent, libraries, dirSep) ? d.parent : null);
      dirs = [...d.directories].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
      browser.hidden = false;
      filterBox.value = "";
      // breadcrumb: every part inside a library folder is clickable, the parts above it are shown greyed out
      const lead = dirSep === "/" ? "/" : d.path.startsWith("\\\\") ? "\\\\" : "";
      crumbsBox.innerHTML = (lead ? `<span class="sepc">${esc(lead)}</span>` : "") + crumbs(d.path, dirSep)
        .map((c) => (inLibrary(c.path, libraries, dirSep) ? `<span data-p="${esc(c.path)}">${esc(c.label)}</span>` : `<span class="nolink">${esc(c.label)}</span>`))
        .join(`<span class="sepc">${esc(dirSep)}</span>`);
      crumbsBox.querySelectorAll("[data-p]").forEach((n) => (n.onclick = () => enter(n.dataset.p)));
      drawList();
    } catch (e) { fail(e); }
  }
  $(el, "[data-browse]").onclick = () => browse(normDir(dest.value, detectSep(dest.value, ...libraries)) || libraries[0] || "/");

  // --- preview ---
  const STATUS = { move: ["will move", "ok"], same: ["already there", "dim"], conflict: ["skipped – name taken", "bad"], zip: ["cannot move", "bad"], nofile: ["no file", "dim"], folder: ["folder gallery", "dim"], left: ["stays", "dim"] };
  function renderPlan(p) {
    const s = p.summary;
    const shown = p.rows.slice(0, MAX_ROWS);
    const rows = shown.map((r) => {
      const [txt, cls] = STATUS[r.status];
      return `<div class="r"><span class="tag ${cls}">${txt}</span><span class="m">${esc(r.basename || r.sceneTitle)}<small>${esc(r.dir)}${r.status === "move" ? " → " + esc(p.destination) : ""}${r.reason && r.status !== "move" ? " · " + esc(r.reason) : ""}</small></span><span class="dim">${esc(fmtBytes(r.size))}</span></div>`;
    }).join("") + (p.rows.length > shown.length ? `<div class="r dim">… and ${p.rows.length - shown.length} more row(s) not shown (all of them will be handled)</div>` : "");
    show(`${p.error ? `<p class="bad big">${esc(p.error)}</p>` : ""}
      <p class="big">${s.move} file(s) will move${s.bytes ? " · " + esc(fmtBytes(s.bytes)) : ""} → ${esc(p.destination || "…")}</p>
      <p class="dim" style="margin:0">${[s.same && `${s.same} already there`, s.conflict && `${s.conflict} skipped (name taken)`, s.zip && `${s.zip} cannot move`, s.nofile && `${s.nofile} ${ns} without a file`, s.folder && `${s.folder} folder-based (cannot move)`, s.left && `${s.left} not selected`].filter(Boolean).join(" · ")}</p>
      ${p.warnings.length ? `<ul class="warn">${p.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
      <div class="tbl">${rows}</div>`);
  }

  $(el, "[data-preview]").onclick = async () => {
    if (busy) return;
    invalidate();
    state.textContent = "Checking the destination…";
    try {
      const sep = detectSep(dest.value, ...libraries, ...scenes.flatMap((s) => s.files.map((f) => f.path)));
      const d = normDir(dest.value, sep);
      const [probe] = await Promise.all([d && isAbsolute(d) ? probeDestination(gql, d) : { existing: [], folderKnown: false }, jobsAllow()]);
      plan = buildPlan({ scenes, destination: dest.value, mode: mode(), existing: probe.existing, libraries, folderKnown: probe.folderKnown, kind });
      if (watchtower) plan.warnings.push(WATCHTOWER_WARNING);
      renderPlan(plan);
      state.textContent = "";
      go.textContent = plan.summary.move ? `Move ${plan.summary.move} file(s)` : "Nothing to move";
      refreshGo();
    } catch (e) { fail(e); }
  };

  // --- execute + verify ---
  go.onclick = async () => {
    if (busy || !plan || plan.error || !plan.summary.move) return;
    const p = plan;
    if (!(await jobsAllow())) { state.textContent = "A blocking job is running – see above."; return; } // re-check right before moving
    const c = await ui.confirmDialog({
      title: `Move ${p.summary.move} file(s)?`,
      text: `To ${p.destination}. Stash moves the files and updates its database. Files whose name is already taken are never overwritten.`,
      ok: "Move",
    });
    if (!c.ok) return;
    busy = true; stopRequested = false; refreshGo();
    $(el, "[data-preview]").disabled = true;
    cancel.textContent = "Stop after this file";
    window.addEventListener("beforeunload", guard);
    try {
      const results = await executePlan(gql, p,
        (i, n, row) => { if (alive) state.textContent = row ? `Moving ${i + 1} / ${n}: ${row.basename}` : "Verifying…"; },
        () => stopRequested);
      let verifyError = null;
      try { await verifyResults(gql, results, p.sep); }
      catch (e) { verifyError = String((e && e.message) || e); results.forEach((r) => { r.actual = null; r.verified = false; }); }
      const moved = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok && !r.skipped);
      const notTried = results.filter((r) => r.skipped);
      const odd = results.filter((r) => !r.verified);
      const report = {
        when: new Date().toISOString(), kind, destination: p.destination, verifyError, stopped: notTried.length > 0,
        moved: moved.map((r) => ({ file: r.row.fileId, from: r.row.path, to: r.actual })),
        failed: failed.map((r) => ({ file: r.row.fileId, from: r.row.path, error: r.error, now: r.actual })),
        notAttempted: notTried.map((r) => ({ file: r.row.fileId, from: r.row.path })),
        skipped: p.rows.filter((r) => ["conflict", "zip"].includes(r.status)).map((r) => ({ from: r.path, reason: r.reason })),
      };
      console.info("[Bulk move]", report);
      stashui.store.set("lastReport", report);
      if (moved.length) stashui.store.set(recentKey, [p.destination, ...recent.filter((x) => x !== p.destination)].slice(0, 5));
      const headline = `Moved ${moved.length}${failed.length ? `, ${failed.length} failed` : ""}${notTried.length ? `, ${notTried.length} not attempted (stopped)` : ""}.`;
      if (alive) {
        state.textContent = "";
        const sorted = [...failed, ...notTried, ...moved];
        show(`<p class="big ${failed.length || odd.length || notTried.length ? "bad" : "ok"}">Moved ${moved.length} · Failed ${failed.length}${notTried.length ? ` · Not attempted ${notTried.length} (stopped)` : ""}${odd.length ? ` · ${odd.length} not as expected` : ""}</p>
          <p class="dim" style="margin:0">${verifyError ? "The moves ran, but checking the result afterwards failed (" + esc(verifyError) + "). Check the files in Stash before doing anything else." : odd.length ? "Checked against Stash again – see the lines marked ⚠." : "Checked against Stash again: every file is where it should be."}${notTried.length ? " The batch was stopped; the files not attempted are still where they were. Run Preview again to continue." : ""}</p>
          <div class="tbl">${sorted.slice(0, MAX_ROWS).map((r) => `<div class="r"><span class="tag ${r.ok ? "ok" : r.skipped ? "dim" : "bad"}">${r.ok ? "moved" : r.skipped ? "not attempted" : "failed"}${r.verified ? "" : " ⚠"}</span><span class="m">${esc(r.row.basename)}<small>${r.ok ? esc(r.actual || "?") : (r.skipped ? "" : esc(r.error) + " · ") + "still at " + esc(r.actual || r.row.path)}</small></span></div>`).join("")}${sorted.length > MAX_ROWS ? `<div class="r dim">… and ${sorted.length - MAX_ROWS} more (see Copy report)</div>` : ""}</div>
          <button class="kb-btn" data-copy type="button">Copy report</button>`);
        const cb = $(el, "[data-copy]");
        cb && (cb.onclick = () => { try { navigator.clipboard.writeText(JSON.stringify(report, null, 2)); ui.toast("Report copied."); } catch (e) { ui.toast("Copy not available – see the browser console.", "error"); } });
      }
      // Always tell the user, also when the drawer was closed meanwhile.
      ui.toast(headline, failed.length || notTried.length ? "error" : undefined);
      if (moved.length) ctx.reload && ctx.reload();
    } catch (e) { fail(e); }
    finally {
      window.removeEventListener("beforeunload", guard);
      busy = false; plan = null;
      go.textContent = "Move"; cancel.disabled = false; cancel.textContent = "Close";
      const pv = $(el, "[data-preview]"); if (pv) pv.disabled = false;
      refreshGo();
    }
  };
}

const kindOf = (ctx) => {
  const k = String((ctx && ctx.kind) || "").toLowerCase();
  return k.startsWith("image") ? "image" : k.startsWith("scene") ? "scene" : k.startsWith("galler") ? "gallery" : null;
};

export default function setup(stashui) {
  if (!stashui.has("slot:bulk.actions")) return; // older Stash UI without the selection-bar slot
  stashui.addSlot("bulk.actions", {
    id: "move",
    match: (ctx) => {
      const k = kindOf(ctx);
      console.debug("[Bulk move] bulk.actions ctx.kind =", ctx && ctx.kind, "->", k); // helps if the button is missing on a page
      return !!k;
    },
    mount(host, ctx) {
      const kind = kindOf(ctx);
      const b = document.createElement("button");
      b.className = "kb-btn";
      b.type = "button";
      b.textContent = "Move to folder…";
      b.title = `Move the selected ${nounPl(kind)}' ${kind === "gallery" ? "archives" : "files"} into a folder (Stash updates its database)`;
      b.onclick = () => openMove(stashui, ctx, kind).catch((e) => stashui.ui.errorToast(e, "Bulk move"));
      host.appendChild(b);
      return () => b.remove();
    },
  });
}
