const DEFAULT_SETTINGS = {
  sponsorMode: "autoskip",
  musicOfftopicMode: "autoskip",
  introMode: "button",
  selfpromoMode: "button",
  interactionMode: "button",
  highlight: false,
  showToast: true,
  showBar: true,
};

const selects = Array.from(document.querySelectorAll("select[data-key]"));
const checkboxes = Array.from(document.querySelectorAll("input[type=checkbox][data-key]"));

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  for (const sel of selects) {
    sel.value = settings[sel.dataset.key] ?? DEFAULT_SETTINGS[sel.dataset.key];
  }
  for (const box of checkboxes) {
    box.checked = Boolean(settings[box.dataset.key]);
  }
});

for (const sel of selects) {
  sel.addEventListener("change", () => {
    chrome.storage.sync.set({ [sel.dataset.key]: sel.value });
  });
}

for (const box of checkboxes) {
  box.addEventListener("change", () => {
    chrome.storage.sync.set({ [box.dataset.key]: box.checked });
  });
}
