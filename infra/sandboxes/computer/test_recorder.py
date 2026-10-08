"""Offline regressions for the teaching recorder helper (no browser needed)."""
import base64
import importlib.machinery
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).parent
loader = importlib.machinery.SourceFileLoader("recorder", str(HERE / "nova-recorder"))
spec = importlib.util.spec_from_loader(loader.name, loader)
rec = importlib.util.module_from_spec(spec)
loader.exec_module(rec)

REC_ID = "abcdef012345"


class RecorderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.object(rec, "ROOT", self.tmp.name)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.makedirs(os.path.join(self.tmp.name, REC_ID))
        self.recorder = rec.Recorder(REC_ID, pb=None, source="")
        self.recorder.sessions["s1"] = {"url": "https://shop.example.test/cart"}

    def actions(self):
        return rec.cmd_pull(REC_ID)["actions"]

    def test_redacts_url_credentials_and_tokens(self):
        url = rec.safe_url("https://user:pw@shop.example.test:8443/a?token=abc&q=shoes#access_token=zzz")
        self.assertEqual(url, "https://shop.example.test:8443/a?token=%5Bredacted%5D&q=shoes")

    def test_login_like_urls(self):
        self.assertTrue(rec.login_like("https://id.example.test/oauth/authorize"))
        self.assertTrue(rec.login_like("https://shop.example.test/account/login"))
        self.assertFalse(rec.login_like("https://shop.example.test/cart"))

    def test_secret_action_never_gets_a_keyframe(self):
        self.recorder.record("s1", {"kind": "secret", "name": "Password"})
        self.assertNotIn("keyframe", self.actions()[0])
        self.assertEqual(self.recorder.pending, {})

    def test_no_frame_flag_and_login_pages_skip_keyframes(self):
        self.recorder.record("s1", {"kind": "click", "name": "Pay", "noFrame": True})
        self.recorder.sessions["s1"]["url"] = "https://shop.example.test/login"
        self.recorder.record("s1", {"kind": "click", "name": "Next"})
        self.assertFalse(any("keyframe" in a for a in self.actions()))
        self.assertTrue(all("noFrame" not in a for a in self.actions()))

    def test_actions_in_one_window_share_a_keyframe_and_stay_ordered(self):
        self.recorder.record("s1", {"kind": "click", "name": "Add"})
        self.recorder.record("s1", {"kind": "click", "name": "Cart"})
        first, second = self.actions()
        self.assertEqual((first["seq"], second["seq"]), (1, 2))
        self.assertEqual(first["keyframe"], second["keyframe"])
        self.assertEqual(first["url"], "https://shop.example.test/cart")

    def test_keyframes_are_capped(self):
        self.recorder.frames = rec.MAX_KEYFRAMES
        self.recorder.record("s1", {"kind": "click", "name": "Add"})
        self.assertNotIn("keyframe", self.actions()[0])

    def test_spa_and_duplicate_navigation(self):
        self.recorder.navigated("s1", "https://shop.example.test/a", spa=False)
        self.recorder.navigated("s1", "https://shop.example.test/a", spa=False)
        self.recorder.navigated("s1", "about:blank", spa=False)
        self.assertEqual([a["kind"] for a in self.actions()], ["navigate"])

    def test_pull_lists_keyframes_and_frame_returns_base64(self):
        path = os.path.join(self.tmp.name, REC_ID)
        Path(path, "k2.jpg").write_bytes(b"jpg2")
        Path(path, "k10.jpg").write_bytes(b"jpg10")
        self.assertEqual(rec.cmd_pull(REC_ID)["keyframes"], ["k2", "k10"])
        self.assertEqual(base64.b64decode(rec.cmd_frame(REC_ID, "k2")), b"jpg2")

    def test_rejects_path_traversal(self):
        with self.assertRaises(ValueError):
            rec.rec_dir("../etc")
        with self.assertRaises(ValueError):
            rec.cmd_frame(REC_ID, "../../x")

    def test_discard_removes_the_directory(self):
        rec.cmd_discard(REC_ID)
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, REC_ID)))

    def test_injected_script_reports_through_the_binding(self):
        source = (HERE / "nova-recorder.js").read_text()
        self.assertIn(rec.BINDING, source)
        self.assertIn("password", source)
        json.dumps(source)


if __name__ == "__main__":
    unittest.main()
