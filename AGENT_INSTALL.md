# Rove installation guide for AI agents

Use this guide to install Rove from source, build its macOS desktop application, and report what you verified. Run commands from the repository root unless a step specifies another directory.

## 1. Check the host and checkout

Rove uses Electron, Vue, and a bundled DeepSeek Harness runtime. Source installation requires a macOS host, Git, npm, and Node.js **24.9.0 or newer**. Dependency installation downloads packages and platform-specific runtimes. A graphical desktop is needed to verify the app window.

```sh
uname -s
uname -m
git --version
node --version
npm --version
```

Confirm that the operating system is `Darwin` and select a compatible Node.js runtime before installing dependencies. Use a Node installation matching the host architecture so the Electron, Node, and native DSH dependencies agree.

The current build has been exercised on Apple Silicon (`arm64`). Dependencies include Intel macOS variants, while end-to-end Intel and universal builds still need validation on their target machines.

For a fresh checkout, choose an installation directory and run the following.

```sh
git clone https://github.com/cosmorithm/Rove.git
cd Rove
```

When the user supplies an existing checkout, inspect it first and work in that directory.

```sh
pwd
git remote -v
git status --short
```

Preserve existing source changes, Git identity, configuration, and application data throughout installation. Quote paths containing spaces in subsequent commands.

## 2. Install locked dependencies and Electron

```sh
npm ci --include=dev --include=optional
npm exec -- install-electron
```

Wait for each command to succeed before continuing. Install development and optional dependencies and allow the package lifecycle scripts to run. Vite, Electron, the bundled Node executable, and native harness dependencies rely on this installation.

The explicit `install-electron` command installs the runtime used by the packaging workflow. The development script also invokes it through `predev`.

Check the installed versions.

```sh
cat node_modules/electron/dist/version
./node_modules/node/bin/node --version
./node_modules/npm/bin/npm-cli.js --version
```

The current repository pins Electron **45.3.1**, bundled Node.js **24.22.1**, and bundled npm **11.6.2**. Check `package.json` for the values in the checkout being installed. Preserve the lockfile and dependency pins when resolving an installation failure.

If dependency or runtime downloads fail, diagnose network access, proxy settings, available disk space, and the active Node architecture, then retry the failed step. Electron runtime installation can be retried with `npm exec -- install-electron` after package installation succeeds.

## 3. Prepare configuration

Create `.env` from the example when the file is absent.

```sh
if [ ! -e .env ]; then
  cp .env.example .env
fi
```

An existing `.env` contains the user's settings and should be retained. The application can build and open with an unconfigured model.

### Chat, polish, and summaries

Open **AI settings** (`AI 设置`) in Rove, select a provider, enter the user's API key, and save. The dialog prefills a service address and model and provides **Fetch models**, **Test connection**, and **Save configuration** actions. Custom compatible endpoints and manual model IDs are supported.

Saving writes the Chat settings into `.env`. Direct file configuration uses these fields.

```dotenv
ROVE_AI_PROVIDER=deepseek
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-flash
OPENAI_API_KEY=
```

Use credentials supplied for the selected service and choose a model available to that account. Chat, answer polish, and summary generation share this configuration. Remote endpoints use HTTPS, and local compatible services can use HTTP on loopback addresses.

### Optional Coding configuration

Coding uses the bundled DeepSeek Harness and has separate settings.

```dotenv
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic
DEEPSEEK_MODEL=
```

An empty `DEEPSEEK_MODEL` uses the bundled harness default. In Coding mode, refresh the engine status after configuring it. The selected code project's Git identity is used for snapshots and conversation commits.

Keep actual credentials in the local `.env`. Installation logs and the final report can describe whether credentials are configured without including their values. `.gitignore` excludes `.env` and its temporary files.

## 4. Build and run automated checks

```sh
npm run build
test -f out/main/index.js
test -f out/preload/index.js
test -f out/renderer/index.html
./node_modules/node/bin/node --test src/tests/*.test.mjs electron/main/tests/*.test.mjs
```

The build produces the main process, preload bridge, and renderer in `out/`. The test command explicitly uses the bundled Node runtime, including its TypeScript support. Record command exit codes and investigate failures before reporting a successful verification.

## 5. Create the macOS app

```sh
npm run package:mac
```

This command rebuilds the application and runs `scripts/package-mac.mjs`. Use the npm script so the installed Node and npm executables are on the command's `PATH`.

The output is **`Rove.app` in the repository root**. It includes Electron, the built application, DSH, and its standalone Node/npm runtime. Packaging checks the runtime versions and stages a replacement for a previous Rove bundle with identifier `local.zhixu.study`.

Verify the bundle.

```sh
test -d Rove.app
/usr/bin/plutil -extract CFBundleIdentifier raw Rove.app/Contents/Info.plist
test -f Rove.app/Contents/Resources/app/out/main/index.js
test -f Rove.app/Contents/Resources/app/out/preload/index.js
test -f Rove.app/Contents/Resources/app/out/renderer/index.html
test -f Rove.app/Contents/Resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
./Rove.app/Contents/Resources/dsh-runtime/node_modules/node/bin/node --version
```

The identifier should be `local.zhixu.study`, and the packaged Node version should match `package.json`. This workflow creates a local application bundle. Distribution signing and notarization require a separate release workflow.

## 6. Launch and check the desktop workflow

Launch the generated application with the available desktop tools or the macOS launcher.

```sh
open ./Rove.app
```

Use the Electron window for UI verification. A development session can instead be started with `npm run dev`. `npm start` previews an existing build and therefore requires `out/` to have been generated first.

Check the parts supported by the available environment.

- **Window and navigation** — The desktop window opens, and Chat and Coding can be selected.
- **Appearance** — Open **Appearance settings** (`外观设置`) at the bottom of the sidebar. Change the palette or text size, reopen the dialog, and confirm the selection is retained.
- **Chat** — With a configured model, send a small question, open the answer, and create a follow-up. Confirm both turns appear on the map.
- **Polish and review** — On a completed leaf node, use **Polish answer** (`打磨回答`). Confirm a new answer version is available. Select a source-text range in **Character review** (`字符级审核`), approve it, and confirm it appears in the conversation's Wiki.
- **Coding, when configured** — Use an empty temporary project folder for a smoke test. Confirm Rove initializes Git and shows the selected directory. A model run creates a conversation commit in that project.

Connection tests and model-backed checks make requests to the configured provider. Use a small test prompt. Record model checks as pending when credentials are unavailable, and GUI checks as pending when the desktop cannot be observed.

## Configuration and data locations

| Item | Location |
| --- | --- |
| Source and development configuration | `.env` in the repository root |
| Packaged app configuration | `.env` beside `Rove.app` |
| Build output | `out/` in the repository root |
| Packaged desktop app | `Rove.app` in the repository root |
| Existing application data | `~/Library/Application Support/知序/` |
| Coding source and per-turn Git records | The project directory selected in Coding |

The application retains its historical `知序` data directory for compatibility. Keep `Rove.app` beside its configuration when moving the local installation. Existing history, imported PDFs, and API settings should remain available during upgrades.

## Troubleshooting

| Symptom | Next check |
| --- | --- |
| Engine or Node version errors during installation | Check `node --version`, select Node 24.9 or newer, and rerun the failed installation step. |
| Missing Electron executable or `dist/version` | Run `npm exec -- install-electron` after `npm ci` succeeds. |
| Missing bundled Node or native DSH module | Check lifecycle scripts, optional dependencies, and host architecture, then retry dependency installation. |
| Packaging reports a runtime version mismatch | Compare installed versions with `package.json` and reinstall the locked dependencies/runtime. |
| Packaging finds a different app at `Rove.app` | Inspect that destination and choose a separate installation directory for Rove. |
| App opens with an unconfigured model | Open AI settings and save a provider, model, and key. Check the `.env` beside the app being launched. |
| Chat works while Coding reports missing credentials | Check the separate `DEEPSEEK_API_KEY` configuration and refresh the Coding engine. |
| macOS displays a malware or harmful-software warning | Record the exact warning and affected path. Verify the runtime's source and integrity before attempting another launch. |
| Desktop automation or a graphical session is unavailable | Complete the build, tests, and bundle checks, and report desktop launch verification as pending. |

## Final installation report

Report the checkout path and revision, host architecture, installed runtime versions, build and test results, and absolute `Rove.app` path. Include the launch result and the status of Chat and Coding checks. List any remaining blocker or pending verification with its concrete cause, and keep credentials out of the report.
