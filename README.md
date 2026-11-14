# Rove

Rove explores a graph-based way to work with AI. Start from a question, follow an idea, return to an earlier node, and open another branch. Each path stays available to revisit and continue.

Rove brings learning and coding into one macOS application. Learning mode helps you study PDFs, textbooks, and problem sets. Coding mode connects branching conversations to a local Git project and DeepSeek Harness (dsh). A map holds your questions and their relationships, while a side reader displays source material, answers, code, and changes.

![Rove showing branching questions and a mathematical explanation in the side reader](docs/images/rove-desktop.jpg)

Rove is an early prototype. The current interface and default tutoring prompts are in Chinese.

## Exploring with Rove

1. Import a PDF and read it in the side reader.
2. Ask AI to organize the document into knowledge points.
3. Open a knowledge point and ask about a passage, formula, or step you want to understand.
4. Continue from any answer to create a follow-up branch.
5. Return to an earlier node and explore another direction. Your existing branches stay on the map.

You can select text or formulas from an answer, save excerpts, and use them in follow-up questions. Answers support Markdown and LaTeX rendering. You can also edit an answer and switch between the original AI response and your latest revision.

The map supports zoom, fit-to-view, and keyboard navigation. Both the library sidebar and the reading sidebar have draggable dividers, remember their widths, and return to their default widths on double-click.

## Coding mode

Switch to **Coding** and open a project folder. Rove automatically initializes Git for a folder without a repository. Select a file to read or edit, ask DSH to explain the code, or ask it to implement a change in an independent Git worktree.

Every conversation turn is bound to a unique Git commit, including read-only answers and stopped or failed model runs. The commit records that turn's code, question, answer, and supplied conversation context. A child turn points to its selected parent turn's commit. Reopening an earlier node lets you inspect its code or create another exploration from that version.

The side reader includes conversation, code, and diff tabs. File saves check for external changes. You can inspect a turn's before-and-after versions and explicitly commit working-tree changes. Turn records are retained under local `refs/rove/turns/` references in the selected repository.

Coding mode bundles **DeepSeek Harness (dsh)**. Configure `DEEPSEEK_API_KEY` in the project `.env`, then refresh the engine in Coding mode. The default `DEEPSEEK_BASE_URL` is `https://api.deepseek.com/anthropic`, a Messages-compatible endpoint. Set `DEEPSEEK_MODEL` to choose a model, or leave it empty to use the bundled harness default. Your existing Git author and committer configuration is used for snapshots and conversation commits.

## Project direction

Rove investigates a graph-based AI harness in which users can branch, revisit, and switch between exploration paths, with AI tutoring as the first use case.

The proposed context mechanism starts at the active node and follows its ancestors, selecting summaries or original material according to the current question and available context budget. Traceable sources and versioned context would let users inspect the information behind each answer.

The prototype stores questions through parent–child links. Learning mode builds requests from the active knowledge point, selected passage, and direct parent question and answer. Coding mode supplies the selected ancestor conversation path and code context, with each turn's input and result recorded in Git. Automatic ancestor summaries and a reusable harness API are areas for further development.

## Tech stack

| Component | Technology | Role |
| --- | --- | --- |
| Desktop runtime | Electron 45.3.1 | macOS application window, native PDF picker, file access, and model requests |
| Interface | Vue 3 | Reactive conversation map, recursive question cards, and side readers |
| Language | TypeScript | Renderer, preload bridge, and main-process application code |
| Build tooling | electron-vite and Vite | Development server and builds for the Electron main, preload, and renderer processes |
| PDF reader | PDF.js (`pdfjs-dist`) | Page rendering, text selection, and text extraction |
| Math rendering | KaTeX | LaTeX formulas in explanations, questions, and excerpts |
| Markdown | Marked with a custom Vue renderer | Markdown parsing and rendered content |
| Local persistence | Chromium localStorage, local PDF files, and IndexedDB for older imports | Saved questions, revisions, excerpts, and source documents |
| AI integration | OpenAI-compatible Chat Completions API | Configurable model provider through `.env` |
| Coding engine | DeepSeek Harness (`@deepseek-ai/dsh`) | Read-only code questions and implementations in independent Git worktrees |
| Coding runtime | Node.js 24.22.1 and npm 11.6.2 | Bundled standalone runtime for DSH and JavaScript project commands |
| Code versioning | Git | Per-turn commits, immutable code snapshots, branch worktrees, and diffs |

The canvas uses Vue components and SVG connection paths. Electron's preload bridge exposes PDF and AI operations to the renderer. Model configuration is read in the main process.

## Run locally

Use macOS and Node.js **24.9 or newer**. From a fresh checkout, run these commands in the project root.

```sh
npm ci
cp .env.example .env
npm run dev
```

`npm run dev` installs the Electron runtime if needed and starts the desktop application. You can import and read PDFs before configuring a model.

## Configure a model

Edit `.env` in the project root with your provider's base URL, model ID, and API key.

```dotenv
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your-model-id
OPENAI_API_KEY=your-api-key
```

| Variable | Purpose |
| --- | --- |
| `OPENAI_BASE_URL` | API base URL. Rove appends `/chat/completions` when making a request. |
| `OPENAI_MODEL` | Model ID accepted by the configured provider. |
| `OPENAI_API_KEY` | Authentication key required by the provider. A local service may allow an empty value. |

Use HTTPS for remote providers. HTTP is supported for `localhost`, `127.0.0.1`, and `[::1]`.

The **AI settings** button can reveal `.env` in Finder. Save your changes and return to Rove to refresh the displayed configuration. Each model request reads the configuration again.

For a packaged build, place `.env` beside `Rove.app`.

## Build the macOS app

To package directly from a fresh checkout, install dependencies and the Electron runtime before building.

```sh
npm ci
npm exec -- install-electron
npm run package:mac
```

The output is `Rove.app` in the project root. The packaging script uses Electron 45.3.1 and bundles DSH with a separate Node.js 24.22.1 runtime and npm 11.6.2. The packaged app does not require a global DSH or Node installation.

To build the application code on its own, run `npm run build`. Build output is written to `out/`.

## Data and model requests

Imported PDFs and study records are stored on your Mac. The current data directory is `~/Library/Application Support/知序`, retained from earlier builds. Reimporting a PDF with identical contents opens its existing study record.

When you organize a document or ask a question, Rove sends the relevant document text and question context to the model provider configured in `.env`. API keys are read by the Electron main process. `.env`, build output, installed dependencies, and `Rove.app` are excluded by `.gitignore`.

Coding actions send the task, conversation path, and selected code to the DeepSeek provider configured for dsh. Coding projects and worktree locations are registered in the application data directory. Per-turn commits and their conversation records are stored locally in the selected Git repository.

## Current limits

- Automatic knowledge-point generation uses extractable PDF text. Scanned PDFs can be viewed. OCR is a future extension.
- Learning-mode follow-ups currently include the direct parent question and answer. Automatic ancestor summaries are part of the proposed context mechanism.
- Learning-mode request context is capped at 24,000 UTF-16 code units, with a separate 4,000-unit cap for the question. Longer input is truncated.
- Answer editing keeps the original response and the latest revision. Coding-mode Git records retain the original completed turn, with revisions included in later turns when selected as context.
- Source-page links help readers check the original document. Answer verification is a further research goal.
