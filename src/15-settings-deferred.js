import { state } from "./02-state.js";
import { saveSettings } from "./06-settings.js";
import { renderGreetingsList } from "./13-greetings.js";
export let saveSettingsTimer = null;
export function debouncedSaveSettings() {
  if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    saveSettingsTimer = null;
    saveSettings();
  }, 400);
}

export function loadGreetings() {
  if (!state.settings.greetingsList || state.settings.greetingsList.length === 0) {
    state.settings.greetingsList = [{ id: Date.now().toString(), content: "" }];
    saveSettings();
  }
  renderGreetingsList();
}
