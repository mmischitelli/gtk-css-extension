# GTK CSS

Syntax highlighting and IntelliSense for GTK-specific CSS, seamlessly supporting Waybar, GNOME Shell themes, and any GTK application stylesheet.

## Features

### Powered by a custom Language Server
The extension includes a dedicated **GTK CSS Language Server** that provides intelligent code analysis, specifically tailored for GTK's unique CSS syntax.

### `@define-color` support & Cross-file Resolution
Define named color variables and reference them anywhere. The extension recursively resolves variables across files via `@import`:
```css
/* vars.gtk.css */
@define-color base #24273a;

/* main.gtk.css */
@import "vars.gtk.css";
@define-color overlay alpha(@base, 0.9);
```

### Color variable IntelliSense
Type `@` anywhere in a value and get instant completions for all colors defined with `@define-color` in the current file or any imported files — with the resolved value shown as detail.

### Visual Color Preview & Hover
Hover over any GTK color variable (`@name`) to see:
- A **visual color preview** (colored square box).
- The **resolved color value** (even through multiple variable references).
- The original definition if it points to another variable.

### GTK color functions
Full highlighting and support for GTK built-in color functions:
- `alpha(color, factor)` — sets opacity
- `shade(color, factor)` — darkens or lightens
- `mix(color1, color2, factor)` — blends two colors
- `lighter(color)` / `darker(color)` — convenience shorthands

### `-gtk-` prefixed properties & Specialized Validation
- Highlights GTK-specific CSS properties such as `-gtk-icon-source`, `-gtk-icon-size`, `-gtk-dpi`, etc.
- **Intelligent Validation**: Prevents false-positive CSS errors from the standard CSS parser by using a virtual document system that correctly handles GTK variables.

### GTK widget element selectors
Recognizes GTK widget names used as element selectors: `window`, `button`, `headerbar`, `menuitem`, `tooltip`, `popover`, `listbox`, `scrollbar`, and many more.

## Usage

### New files
Create files with the `.gtk.css` extension — the GTK CSS language mode will activate automatically.

### Existing `.css` files
Open the Command Palette (`Ctrl+Shift+P`) and run **Change Language Mode → GTK CSS**.

To apply this automatically for an entire project, add to `.vscode/settings.json`:
```json
{
  "files.associations": {
    "*.css": "gtk-css"
  }
}
```

## Why a dedicated language mode?

GTK CSS uses syntax that is not valid standard CSS — for example `@define-color` and `@color-name` references inside function arguments like `alpha(@base, 0.9)`. Using a dedicated language mode instead of injecting into CSS prevents the built-in CSS Language Server from raising false parse errors and validation warnings on perfectly valid GTK stylesheets.

## License

[MIT](LICENSE)
