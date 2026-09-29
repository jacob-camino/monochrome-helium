# Local Mac installation

The browser must finish building and pass native rendering checks before this
helper installs it. It does not install dependencies or alter browser security
flags. Still uses `com.jacobcamino.still` for both its bundle identifier and its
default profile folder, keeping it separate from Helium and other browsers.

From the repository root, after the standalone release app is built:

```sh
python3 still/macos/install_macos.py build/src/out/Default/Still.app --check-only
python3 still/macos/install_macos.py build/src/out/Default/Still.app --set-default
```

The helper validates the standalone bundle, confirms the distinct profile
fallback in the built source, and launches an isolated headless HTML smoke
check without disabling the sandbox. It stages a copy to `~/Applications`,
preserves any previous Still installation, verifies the copied app, and
registers the browser with LaunchServices.

Setting the default uses macOS's normal NSWorkspace API and verifies both HTTP
and HTTPS handlers by app path and bundle ID. Any macOS consent dialog must be
completed by the user. No settings change occurs with `--check-only`.

This startup check does not validate the UI-layer grayscale filter: native
window rendering, video, full screen, and the hover/focus toggle require a
separate visible-window check after compilation. Public distribution signing,
notarization, and the Still update channel are separate release work.
