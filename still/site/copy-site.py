#!/usr/bin/env python3
"""Copy only Still's page assets into an existing site checkout. Never deploys."""
import argparse
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--site-root', required=True, type=Path)
args = parser.parse_args()
source = Path(__file__).resolve().parent / 'public'
public = args.site_root.resolve() / 'public'
if not public.is_dir():
    raise SystemExit('Expected an existing site checkout with a public directory.')
destination = public / 'still'
if destination.is_symlink():
    raise SystemExit('Refusing to copy into a symlinked destination.')
destination.mkdir(exist_ok=True)
for file in sorted(source.iterdir()):
    if not file.is_file() or file.is_symlink():
        raise SystemExit('Only regular page asset files may be staged.')
    target = destination / file.name
    if target.is_symlink():
        raise SystemExit('Refusing to overwrite a symlinked asset.')
    shutil.copyfile(file, target)
print(f'Staged {len(list(source.iterdir()))} Still assets in {destination}; no deployment performed.')
