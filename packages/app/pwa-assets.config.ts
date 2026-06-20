import {
  defineConfig,
  minimal2023Preset,
} from "@vite-pwa/assets-generator/config";

const preset = minimal2023Preset;
const background = "#1a1a24";
preset.apple.resizeOptions = { background };
preset.maskable.resizeOptions = { background };
preset.maskable.padding = 0.5;

export default defineConfig({
  preset,
  images: ["public/icon.svg"],
});
