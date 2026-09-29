# Still

A personal Helium fork with grayscale pages, an Ink dark theme, a left tab rail,
and local website controls. Color is available through a hover/focus toggle.

The first Mac executable is being built. Nothing has been installed or published
as a Still browser release yet. Experimental on-device text classification is
kept separate from the tested domain blocker.

See [the current direction and status](STILL.md),
[interactive interface studies](designs/index.html),
[the native patches](still/patches/),
[local site controls](still/blocking/README.md), and
[text-model evaluation](still/text-filter/README.md).

Still preserves Helium's sandbox, permissions, security-related build flags,
and existing security checks. These are personal-fork changes, not a proposed
contribution to Helium. The upstream macOS tooling and attribution follow.

---

## Upstream: helium-macos
macOS packaging & development tooling for the
[Helium Browser](https://github.com/imputnet/helium).

## Building and development
macOS is our primary development platform, so it's the recommended environment
for developing new Helium features.

[> See docs/building.md](docs/building.md)

## Contributing
Before contributing to this repo, please read the guidelines in the main repo's
[CONTRIBUTING.md](https://github.com/imputnet/helium/blob/main/CONTRIBUTING.md).

## Credits

### Depot
Big thank you to [Depot](https://depot.dev/) for sponsoring our runners,
which handle the macOS builds of Helium. Their high-performance infrastructure
lets us compile, package, and release new builds of Helium within hours,
not days.

### ungoogled-chromium-macos
This repo is based on
[ungoogled-chromium-macos](https://github.com/ungoogled-software/ungoogled-chromium-macos),
but heavily modified for Helium. Special thanks to everyone behind
ungoogled-chromium, they made working with Chromium infinitely easier.

## License
All code, patches, modified portions of imported code or patches, and
any other content that is unique to Helium and not imported from other
repositories is licensed under GPL-3.0. See [LICENSE](LICENSE).

Any content imported from other projects retains its original license (for
example, any original unmodified code imported from ungoogled-chromium remains
licensed under their [BSD 3-Clause license](LICENSE.ungoogled_chromium)).
