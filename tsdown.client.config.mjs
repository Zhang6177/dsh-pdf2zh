/**
 * Client bundle build for dsh-pdf2zh.
 *
 * Emits lib/client.js as the GUI's ModuleLoader closure-factory artifact:
 * `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`.
 * `react` and `react-dom/client` stay external — the browser loader answers
 * them from its module table (the same contract as the installed
 * dsh-cron-explorer / dsh-token-usage-board bundles).
 */

const BUNDLE_ID = 'dsh-pdf2zh'

const BANNER = '/* dsh-pdf2zh — browser half (built from src/client by tsdown.client.config.mjs) */\n'
  + `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(BUNDLE_ID)},\n\tfactory: function (require) {`
const INTRO = 'var module = { exports: {} };\n\t\tvar exports = module.exports;'
const FOOTER = 'return module.exports;\n\t}\n});'

export default {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: (specifier) => specifier === 'react' || specifier === 'react-dom/client',
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: BANNER,
    footer: FOOTER,
    intro: INTRO,
  },
}
