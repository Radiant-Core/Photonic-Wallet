const config = {
  locales: ["en", "es"],
  // Emit ESM (`export const messages = {...}`) instead of the default CJS
  // (`module.exports = ...`). The dev server loads catalogs via dynamic
  // `import("./locales/<locale>.js")` and Vite's native module loader cannot
  // execute `module.exports` in the browser — it throws
  // `ReferenceError: module is not defined` and the wallet white-screens
  // before render. The production bundler path tolerates CJS via esbuild
  // interop; the dev/HMR path doesn't.
  compileNamespace: "es",
  catalogs: [
    {
      path: "src/locales/{locale}",
      include: ["src"],
    },
  ],
};

export default config;
