import { defineConfig, presetIcons, presetWind3 } from "unocss";

export default defineConfig({
  presets: [presetWind3(), presetIcons({ scale: 1.05 })],
  shortcuts: {
    row: "flex items-center gap-2",
    muted: "text-[var(--muted)]",
    spacer: "flex-1 min-w-0",
  },
});
