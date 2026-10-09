"""Offline checks for nova-recalc with a stand-in soffice (no LibreOffice needed)."""
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("nova-recalc")
FAKE = """#!/bin/sh
# last arg is the input; --outdir is the arg before it minus one
for a in "$@"; do last="$a"; done
prev=""
for a in "$@"; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; done
case "$NOVA_FAKE" in
  fail) exit 3 ;;
  hang) sleep 30 ;;
  *) printf 'recalculated' > "$out/$(basename "$last")" ;;
esac
"""


class RecalcTest(unittest.TestCase):
    def run_recalc(self, mode, *, soffice=True, name="book.xlsx", extra=()):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            if soffice:
                fake = bin_dir / "soffice"
                fake.write_text(FAKE)
                fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            target = Path(tmp) / name
            target.write_bytes(b"original")
            env = {**os.environ, "PATH": f"{bin_dir}:/usr/bin:/bin", "NOVA_FAKE": mode}
            done = subprocess.run([sys.executable, str(SCRIPT), *extra, str(target)],
                                  env=env, capture_output=True, text=True)
            return done.returncode, target.read_bytes(), sorted(p.name for p in Path(tmp).iterdir())

    def test_replaces_file_in_place(self):
        code, data, listing = self.run_recalc("ok")
        self.assertEqual((code, data), (0, b"recalculated"))
        self.assertEqual(listing, ["bin", "book.xlsx"])  # no temp leftovers

    def test_failure_and_timeout_leave_file_untouched(self):
        self.assertEqual(self.run_recalc("fail")[:2], (1, b"original"))
        self.assertEqual(self.run_recalc("hang", extra=("--timeout", "1"))[:2], (1, b"original"))

    def test_missing_libreoffice_is_127(self):
        self.assertEqual(self.run_recalc("ok", soffice=False)[:2], (127, b"original"))

    def test_rejects_non_xlsx(self):
        self.assertEqual(self.run_recalc("ok", name="data.csv")[:2], (1, b"original"))


if __name__ == "__main__":
    unittest.main()
