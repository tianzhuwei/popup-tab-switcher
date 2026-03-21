# AGENTS.md — Popup Tab Switcher

## Project Overview

Chrome extension (Manifest V3) for convenient tab switching via a popup overlay.
Built with SolidJS, TypeScript, SCSS, and Webpack.

## Build / Lint / Test Commands

```bash
# Build
npm run build:dev        # Dev build → build-dev/
npm run build:e2e        # E2E build → build-e2e/
npm run build:prod       # Production build → build-prod/

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

# E2E tests
npm run test:e2e         # build:e2e + mocha ./e2e/
npm run test:e2e:mac     # macOS Chrome path variant
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
- Global declarations in `webpack.d.ts` for build-time constants (`E2E`, `DEVELOPMENT`, `PRODUCTION`)

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

- Prettier runs on all files via lint-staged (`*` → `prettier --ignore-unknown --write`)
- ESLint with airbnb-base config for `.ts`/`.js` files
- No semicolons in some files (mixed style); follow existing file convention
- Double quotes for strings in TypeScript

## Version Numbering

Version in `src/manifest.json` follows `YYYYMMDD.N` format:

- `YYYYMMDD` = date of change
- `N` = sequential number for that day (1, 2, 3, ...)
- Always bump version when making user-facing changes

## Build Output

- `build-dev/` — development build (gitignored)
- `build-e2e/` — E2E test build (gitignored)
- `build-prod/` — production build (gitignored)
- Load `build-dev/` as unpacked extension in Chrome for testing

## Key Patterns

- **Message passing**: `handleMessage()` + `Message` enum in `utils/messages.ts`
- **Settings**: `ISettings` interface in `utils/settings.ts`, reactive store in popup
- **Store**: `createPopupStore()` returns reactive state + actions
- **Shadow DOM**: Popup renders inside shadow root for style isolation
- **SCSS variables**: Theme colors defined in `src/styles/_variables.scss` via mixins
