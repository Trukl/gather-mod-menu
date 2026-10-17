// Share: export and import the presets of the installed modules as JSON.
window.__gatherMods.define("share", (ctx) => {
  const SHARE_FORMAT = "gathermodv2-presets";

  const describe = (counts) =>
    Object.entries(counts)
      .map(([label, n]) => `${n} ${label.toLowerCase()}`)
      .join(", ") || "nothing (no preset module installed)";

  function exportPresets() {
    const data = { format: SHARE_FORMAT, version: 1 };
    const counts = {};
    for (const t of ctx.presetTypes()) {
      data[t.key] = t.list();
      counts[t.label] = data[t.key].length;
    }
    return { text: JSON.stringify(data), counts };
  }
  function importPresets(data) {
    if (data?.format !== SHARE_FORMAT) throw new Error("not a mods export");
    const counts = {};
    for (const t of ctx.presetTypes())
      counts[t.label] = ctx.addPresets(t.type, Array.isArray(data[t.key]) ? data[t.key] : []);
    return counts;
  }
  function downloadText(filename, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  ctx.section({
    title: "Share presets",
    html: `
      <div class="gm-btn-row">
        <button class="gm-btn" id="gm-export" title="Copy the presets of your installed modules to the clipboard and download them as a file"><i class="gm-i" data-i="download"></i>Export</button>
        <button class="gm-btn" id="gm-import-file" title="Import presets from an exported file"><i class="gm-i" data-i="file-up"></i>Import</button>
        <button class="gm-btn" id="gm-import-paste" title="Import presets from pasted text"><i class="gm-i" data-i="clipboard-paste"></i>Paste</button>
      </div>
      <input type="file" id="gm-import-input" accept=".json,application/json" hidden />
      <div class="gm-note" id="gm-share-note"><i class="gm-i sm" data-i="circle-check"></i><span id="gm-share-status"></span></div>`,
    mount(el) {
      const note = el.querySelector("#gm-share-note");
      const setStatus = (text, ok = true) => {
        note.classList.toggle("gm-ok", ok);
        note.classList.toggle("gm-err", !ok);
        note.querySelector(".gm-i").dataset.i = ok ? "circle-check" : "circle-alert";
        el.querySelector("#gm-share-status").textContent = text;
      };
      const runImport = (text) => {
        try {
          setStatus("Imported " + describe(importPresets(JSON.parse(text))));
        } catch (e) {
          setStatus("Import failed: " + (e?.message || e), false);
        }
      };
      el.querySelector("#gm-export").onclick = async () => {
        const { text, counts } = exportPresets();
        downloadText("gather-mods-presets.json", text);
        try {
          await navigator.clipboard.writeText(text);
          setStatus("Copied + downloaded " + describe(counts));
        } catch {
          setStatus("Downloaded " + describe(counts));
        }
      };
      const fileInput = el.querySelector("#gm-import-input");
      el.querySelector("#gm-import-file").onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        const file = fileInput.files[0];
        fileInput.value = "";
        if (file) runImport(await file.text());
      };
      el.querySelector("#gm-import-paste").onclick = () => {
        const text = prompt("Paste exported presets");
        if (text) runImport(text);
      };
    },
  });
});
