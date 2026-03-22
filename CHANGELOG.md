# Changelog

All notable changes to the **GTK CSS** extension will be documented in this file.

## [1.4.0] - 2026-03-22

### Added
- Inline color decorators for GTK color variables via `documentColorProvider`, matching the native behavior of hex/rgb colors in VS Code
- Support for nested GTK color function expressions (e.g. `alpha(shade(@base, 1.2), 0.5)`)

### Fixed
- Autocomplete duplication: typing `@cy` + Tab no longer produces `@cy@cyan`; completion items now use `textEdit` with an explicit replace range
- Hover tooltip showing black/no preview for colors defined via GTK functions (`alpha`, `shade`, `mix`, `lighter`, `darker`)

### Changed
- GTK color functions are now fully evaluated recursively to produce a resolved color value used consistently across hover, inline decorators and color picker
- Type annotations improved throughout the server (`@typedef`, `@type`) for full `@ts-check` compliance

## [1.3.0] - 2026-03-19

### Changed
- Replace file-based logger with LSP-native logging and add debug-level gating (thanks Mark Rapoza!)

## [1.2.0] - 2026-03-15

### Added
- **Language Server Architecture**: Implemented a dedicated Language Server Protocol (LSP) to handle GTK-specific features like `@define-color` and recursive imports.
- **Enhanced Hovers**: Added visual color previews (SVG squares) and recursive resolution for color variable chains.
- **Bundling**: Integrated `esbuild` for high-performance client and server bundling, significantly improving diagnostic accuracy and startup time.
- **Improved Validation**: Added a virtual document system to prevent false-positive CSS errors when using GTK variables.
- Localization: Full translation of the codebase (comments, logs, documentation) from Italian to English.
- Integration Tests: Added an automated test suite covering completions, hovers, and diagnostics.

## [1.1.0] - 2026-03-15

### Added
- Packaging improvements and publisher name update in `package.json`.
- Prepared extension for marketplace submission.

## [1.0.0] - 2026-03-14

### Added
- Initial stable release with core GTK-specific syntax support.
- Stable language registration for `.gtk.css` files.

## [0.3.0] - 2026-03-14

### Added
- `@define-color` completion provider: typing `@` inside a GTK CSS file now shows all color variables defined in the document, with their values as detail and documentation.
- `extension.js` activation entry point for the completion provider.

### Fixed
- `@import url('...')` with single-quoted strings was being incorrectly tokenized due to `gtk-color-reference` pattern matching `@import`. Added negative lookahead to exclude all standard CSS at-rule keywords.

## [0.2.0] - 2026-03-14

### Changed
- **Architecture change**: switched from TextMate injection grammar to a **dedicated language** (`gtk-css`). This eliminates all CSS Language Server parse errors (`Unknown at rule`, `} expected`, etc.) caused by GTK-specific syntax like `alpha(@color, 0.9)`.
- Added `language-configuration.json` with bracket matching, auto-closing pairs and comment tokens.

## [0.1.0] - 2026-03-14

### Added
- Initial release.
- TextMate injection grammar for `source.css` with support for:
  - `@define-color` at-rule highlighting
  - GTK color variable references (`@color_name`)
  - GTK color functions: `alpha()`, `shade()`, `mix()`, `lighter()`, `darker()`
  - `-gtk-` prefixed properties (e.g. `-gtk-icon-effect`)
  - GTK widget element selectors (`window`, `button`, `menuitem`, `tooltip`, `headerbar`, etc.)
- CSS Language Server custom data (`css.customData`) for hover documentation on GTK at-rules and properties.
