"""Regression for git apply silently discovering the wrapper repository."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("still_apply", Path(__file__).parents[1] / "apply.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PatchApplication(unittest.TestCase):
    def check_source(self, source_has_git):
        with tempfile.TemporaryDirectory() as temporary:
            wrapper = Path(temporary)
            subprocess.run(["git", "init", "--quiet", str(wrapper)], check=True)
            source = wrapper / "build/src"
            source.mkdir(parents=True)
            if source_has_git:
                subprocess.run(["git", "init", "--quiet", str(source)], check=True)
            target = source / "identity.txt"
            target.write_text("Helium\n")
            patch = wrapper / "identity.patch"
            patch.write_text("--- a/identity.txt\n+++ b/identity.txt\n@@ -1 +1 @@\n-Helium\n+Still\n")
            self.assertNotEqual(module.git(source, "--reverse", "--check", patch, check=False).returncode, 0)
            module.git(source, "--check", patch)
            self.assertEqual(target.read_text(), "Helium\n")
            module.git(source, patch)
            self.assertEqual(target.read_text(), "Still\n")
            module.git(source, "--reverse", "--check", patch)

    def test_archive_inside_wrapper_repository(self):
        self.check_source(False)

    def test_separate_chromium_repository(self):
        self.check_source(True)


if __name__ == "__main__":
    unittest.main()
