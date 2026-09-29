# Still

A personal Helium fork with grayscale rendering and a minimal, dark interface.

## Current direction

- Name: **Still**.
- Base: Helium, using the pinned `helium-chromium` submodule.
- Keep browser changes in UI and appearance. The separately requested local
  website blocker is the sole additional feature. Preserve Helium's security
  and privacy protections, sandbox, permission handling, and security-related
  build flags. Do not add bypasses.
- Keep upstream diffs small and easy to maintain. Prefer existing Helium
  preferences and UI implementations over new browser infrastructure.
- Grayscale by default, with a color toggle revealed on rail hover or keyboard
  focus. Color mode does not disable website blocking.
- **Margin + Ink**: dark, neutral surfaces, a left tab rail with larger targets,
  and navigation controls hidden by default. Retain the design comparisons.
- One local settings page for blocked websites, allowed exceptions, and an
  optional adult-content filter. Prefer text classification with a small open
  language model, following the user's latest direction. No cloud inference.
- Build and install a Mac executable, then make it the default browser.
- Afterwards, provide downloadable Windows, Linux, and macOS distributions.
- Host release files in Tigris object storage and serve a download page on
  `jacobalbertschmidt.com`, preserving the existing site as appropriate.

The earlier Chromium compositor patch is superseded as the implementation
direction. First evaluate existing UI layer grayscale APIs to keep the Helium
diff small. All platforms need runtime rendering validation; none may be
advertised as complete yet. Any update/signing
limitations in a personal distribution must be resolved or clearly surfaced
before release, never silently addressed by disabling protection.

## Interface studies

Open [designs/index.html](designs/index.html). The studies simulate pages and
navigation; they are interface prototypes, not the compiled browser.

1. **Clear** — frameless, with navigation revealed at the top edge.
2. **Pocket** — a small floating navigation bar.
3. **Margin** — a narrow rail for open pages.

The selected direction is Margin with Ink. The other studies remain available
for comparison. Compare reading and blank new-tab states and the color toggle.
Use `/` to open the mock navigation, Escape to dismiss it, and “Try full size”
to focus on one design. These prototype keys are separate from Helium's native
shortcuts. In native Helium, Command-L reveals the address bar and
Command-Shift-L pins/unpins the top controls.

## Build status

The earlier Chromium-only build was stopped when the base changed to Helium.
Helium source preparation targets Chromium 154.0.8037.57. No Still executable
has been built or installed yet. The default browser has not been changed. Cross-platform builds and
deployment are pending; no release downloads have been published.

## Local website filtering

Keep custom filtering in a separate packaged extension using standard Chromium
APIs, so Helium's networking/security implementation and uBlock remain intact.
Manual domain rules and a bundled adult-domain list run before navigation.
Explicit allow rules override Still's other rules only, never another
extension's or the browser's security decisions.

The optional model should classify URL, title, and a bounded sample of visible
page text for pornographic intent. It must distinguish sexual-health education,
medical information, art, reporting, and support resources from pornography.
Text is untrusted data: no tools, no generated executable code, no ability for
model output to edit domain rules. Decisions apply to individual pages, not a
permanent ban of an entire mixed-content domain. Keep form inputs out of samples,
and do not retain page text, transmit it, or sync it.

Model choice is pending a measured comparison. Tiny generative models are
larger than specialized classifiers; promising candidates are SmolLM2-135M and
Qwen3.5-0.8B. Headline general benchmarks do not establish porn-filter accuracy.
Text-only filtering cannot assess image-only or video-only material, and page
text is available only after a response loads. Keep these limitations visible
when enabling the optional feature. No AI filter is implemented or advertised
as working until runtime and classification checks pass.

Keep all custom changes in this personal fork. Do not submit them upstream.
