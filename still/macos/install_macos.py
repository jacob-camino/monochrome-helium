#!/usr/bin/env python3
"""Validate and install a locally built Still .app on Apple Silicon."""

import argparse
import datetime
import os
from pathlib import Path
import plistlib
import re
import signal
import subprocess
import sys
import tempfile
import time


def run(command, **kwargs):
    return subprocess.run(command, check=True, text=True, **kwargs)


def validate(app, check_args=False):
    app = app.resolve()
    if app.suffix != ".app" or not app.is_dir():
        raise ValueError(f"Not an application bundle: {app}")
    if check_args:
        args_file = app.parent / "args.gn"
        args_text = args_file.read_text()
        if re.search(r"^\s*is_component_build\s*=\s*true\b", args_text, re.M):
            raise ValueError(f"A component build cannot be installed: {args_file}")
        if not re.search(r"^\s*is_official_build\s*=\s*true\s*(?:#.*)?$", args_text, re.M):
            raise ValueError(f"Expected Helium's standalone official release configuration: {args_file}")
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError(f"Missing executable: {executable}")
    if info.get("CFBundleName") != "Still":
        raise ValueError("Application must use Still branding before installation.")
    if info.get("CFBundleIdentifier") != "com.jacobcamino.still":
        raise ValueError("Still must have its own com.jacobcamino.still bundle identifier.")
    if info.get("CrProductDirName", "com.jacobcamino.still") != "com.jacobcamino.still":
        raise ValueError("Unexpected browser profile override.")
    # The upstream macOS profile fallback is changed by the narrow identity
    # patch. Check the built source too, before copying an installed bundle.
    if check_args:
        paths_file = app.parent.parent.parent / "chrome/common/chrome_paths_mac.mm"
        if 'product_dir_name = "com.jacobcamino.still";' not in paths_file.read_text():
            raise ValueError("Source does not isolate Still's default profile from Helium.")
    schemes = {scheme for item in info.get("CFBundleURLTypes", []) for scheme in item.get("CFBundleURLSchemes", [])}
    if not {"http", "https"}.issubset(schemes):
        raise ValueError("The application must declare both HTTP and HTTPS URL handlers.")
    if not any((app / "Contents/Frameworks").glob("* Framework.framework")):
        raise ValueError("Missing Chromium framework in the application bundle.")
    for directory, folders, files in os.walk(app, followlinks=False):
        for name in folders + files:
            entry = Path(directory) / name
            if entry.is_symlink():
                target = entry.resolve(strict=True)
                if app != target and app not in target.parents:
                    raise ValueError(f"Application contains an external symlink: {entry} -> {target}")
    architectures = run(["/usr/bin/lipo", "-archs", str(executable)], capture_output=True).stdout.split()
    if "arm64" not in architectures:
        raise ValueError(f"Application is not built for Apple Silicon: {architectures}")
    version = f"{info.get('CFBundleName', 'Still')} {info.get('CFBundleShortVersionString', 'unknown')}"
    print(f"Validated {version} ({info['CFBundleIdentifier']}) at {app}", flush=True)
    return executable


def smoke_test(app):
    executable = validate(app)
    with tempfile.TemporaryDirectory(prefix="still-smoke-") as profile:
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            process = subprocess.Popen([
                str(executable), "--headless", "--no-first-run", "--no-default-browser-check",
                "--disable-background-networking", "--disable-component-update",
                f"--user-data-dir={profile}", "--dump-dom",
                "data:text/html,<title>Still smoke check</title><p>browser ready</p>",
            ], stdout=stdout, stderr=stderr, text=True, start_new_session=True)
            try:
                deadline = time.monotonic() + 90
                while True:
                    # pread does not move the shared file offset while Chromium
                    # writes. Poll before reading so its final write is included.
                    exited = process.poll() is not None
                    rendered = os.pread(stdout.fileno(), 1_000_000, 0).decode("utf-8", "replace")
                    if "<title>Still smoke check</title>" in rendered and "browser ready" in rendered:
                        break
                    if exited or time.monotonic() >= deadline:
                        errors = os.pread(stderr.fileno(), 1_000_000, 0).decode("utf-8", "replace")
                        raise ValueError(f"Browser smoke check failed.\n{errors[-4000:]}")
                    time.sleep(0.25)
            finally:
                # Chromium can retain background services after producing output.
                # Stop only this check's process group before deleting its profile.
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    try:
                        os.killpg(process.pid, sig)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
    print("Browser startup and HTML rendering smoke check passed.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("application", type=Path, help="Built .app next to its args.gn")
    parser.add_argument("--check-only", action="store_true", help="Validate and smoke-test without installing")
    parser.add_argument("--set-default", action="store_true", help="Request macOS consent and verify HTTP/HTTPS defaults after installation")
    args = parser.parse_args()
    if args.check_only and args.set_default:
        parser.error("--check-only and --set-default cannot be combined")
    source = args.application.expanduser().resolve()
    validate(source, check_args=True)
    smoke_test(source)
    if args.check_only:
        return

    applications = Path.home() / "Applications"
    applications.mkdir(exist_ok=True)
    destination = applications / "Still.app"
    if source == destination.resolve():
        raise ValueError("Source must be the build output, not the installed application.")
    with tempfile.TemporaryDirectory(prefix=".still-install-", dir=applications) as temporary:
        staged = Path(temporary) / "Still.app"
        run(["/usr/bin/ditto", str(source), str(staged)])
        smoke_test(staged)
        if destination.exists():
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            backup = applications / f"Still.previous-{stamp}.app"
            destination.rename(backup)
            print(f"Previous installation preserved at {backup}", flush=True)
        staged.rename(destination)
    register = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    run([register, "-f", str(destination)])
    print(f"Installed {destination}", flush=True)

    if args.set_default:
        source_swift = Path(__file__).resolve().with_name("default_browser.swift")
        with tempfile.TemporaryDirectory(prefix="still-default-helper-") as temporary:
            helper = Path(temporary) / "default-browser"
            run(["/usr/bin/xcrun", "swiftc", "-parse-as-library", str(source_swift), "-o", str(helper)])
            print("Requesting default browser change. Complete any macOS confirmation dialog.", flush=True)
            run([str(helper), "--set", str(destination)])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"Install failed: {error}", file=sys.stderr)
        sys.exit(1)
