# AGENTS.md — Popup Tab Switcher

## Project Overview

Chrome extension (Manifest V3) for convenient tab switching via a popup overlay.
Built with SolidJS, TypeScript, SCSS, and Webpack.

## Build / Lint / Test Commands

```bash
# Build
npm run build:dev        # Dev build → /Applications/01-CrhomeExtension/TabPop
npm run build:prod       # Production build → build-prod_<timestamp>/

# Dev server (watch mode)
npm run start            # webpack watch --env development

# Type check
npm run test:ts          # tsc --noEmit

# Lint
npm run lint             # eslint --ext .ts,.js ./

# Unit tests (mocha + ts-node)
npm test                 # mocha --bail ./src/**/*-test.{js,ts}
# Run a single test file:
npx mocha --require ts-node/register --bail ./src/utils/tab-registry-test.js

```

## Project Structure

```
src/
├── background.ts              # Service worker entry
├── background/                # Background helpers
├── content-script/            # Popup overlay (SolidJS components + SCSS)
│   ├── index.ts               # Content script entry
│   ├── popup.tsx              # Main Popup component
│   ├── popup-tab.tsx          # Individual tab item component
│   ├── popup-store.ts         # Reactive store
│   └── popup.scss             # Popup styles (non-module SCSS)
├── settings/                  # Settings page (SolidJS)
│   ├── solid-js/              # Settings UI components
│   └── index.html             # Settings page HTML
├── styles/                    # Shared SCSS variables/mixins
├── utils/                     # Shared utilities, messages, settings
├── icons/                     # Extension icons
└── manifest.json              # Chrome extension manifest
```

## Code Style

### Language & Framework

- **TypeScript** with `strict: true` (tsconfig.json)
- **SolidJS** for UI (JSX via `jsxImportSource: "solid-js"`)
- **SCSS** for styles; content-script uses raw SCSS strings, settings uses CSS modules (`*.module.scss`)

### Imports

- Use relative paths (`../utils/messages`, `./popup-tab`)
- Group: SolidJS → local styles → utilities → types
- Named exports preferred; default exports only for legacy modules

### Naming Conventions

- **Files**: kebab-case (`popup-tab.tsx`, `tab-registry-test.js`)
- **Interfaces**: `I` prefix (`ISettings`, `IProps`, `ITab`)
- **Components**: PascalCase (`PopupTab`, `SettingsForm`)
- **Functions/variables**: camelCase (`selectNextTab`, `isMouseOverCard`)
- **Constants**: UPPER_SNAKE_CASE or camelCase for module-level (`MOUSE_IDLE_DURATION`)
- **CSS classes**: BEM-ish (`tab_selected`, `tab__closeButton`, `tab__pinButton_pinned`)
- **CSS variables**: kebab-case with component prefix (`--tab-height`, `--tab_accent-color`)

### Types

- Prefer `interface` over `type` for object shapes
- Use `chrome.tabs.Tab` directly or alias as `type ITab = chrome.tabs.Tab`
- Avoid `any`; use `unknown` if needed
- Global declarations in `webpack.d.ts` for build-time constants (`DEVELOPMENT`, `PRODUCTION`)

### Components (SolidJS)

- Props interface named `IProps` in the same file
- Destructure store/actions at top of component function
- Place JSX return before helper functions (see popup.tsx pattern)
- Use `classList` for conditional classes, not string concatenation
- Use `Show` and `For` from `solid-js/web` for conditional/list rendering

### Error Handling

- No global error boundary; rely on Chrome extension error reporting
- Use `log()` from `utils/logger` for debug logging
- Guard against undefined with early returns

### Formatting

- Use Prettier on changed files while preserving existing file conventions
- ESLint with airbnb-base config for `.ts`/`.js` files
- No semicolons in some files (mixed style); follow existing file convention
- Double quotes for strings in TypeScript

## Version Numbering

Version in `src/manifest.json` follows `YYYYMMDD.N` format:

- `YYYYMMDD` = date of change
- `N` = sequential number for that day (1, 2, 3, ...)
- Always bump version when making user-facing changes

## Build Output

- `/Applications/01-CrhomeExtension/TabPop` — configured development output
- `build-prod_<timestamp>/` — production build and ZIP archive (gitignored)
- Load the configured development output as an unpacked extension in Chrome
- Development builds include an automatic Chrome reload hook; disable it when only compilation is authorized

## Key Patterns

- **Message passing**: `handleMessage()` + `Message` enum in `utils/messages.ts`
- **Settings**: `ISettings` interface in `utils/settings.ts`, reactive store in popup
- **Store**: `createPopupStore()` returns reactive state + actions
- **Shadow DOM**: Popup renders inside shadow root for style isolation
- **SCSS variables**: Theme colors defined in `src/styles/_variables.scss` via mixins
