import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".github/scripts/resolve-candidate.py"
SPEC = importlib.util.spec_from_file_location("resolve_candidate", SCRIPT)
candidate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(candidate)
TIP = "a" * 40
OLD = "b" * 40
FOREIGN = "c" * 40


def event():
    return {"repository": {"full_name": candidate.REPOSITORY, "default_branch": "main"},
            "ref": candidate.MAIN_REF, "after": TIP, "deleted": False}


class CandidateGateTests(unittest.TestCase):
    def resolve(self, name="push", payload=None, ref=candidate.MAIN_REF, sha=TIP,
                repository=candidate.REPOSITORY):
        return candidate.resolve(name, event() if payload is None else payload, repository, ref, sha,
                                 TIP, lambda target, tip: target in (TIP, OLD) and tip == TIP)

    def dispatch(self, operation="release", sha=TIP):
        payload = event()
        payload["inputs"] = {"operation": operation, "sha": sha}
        return payload

    def test_push_releases_only_the_exact_event_sha(self):
        self.assertEqual(self.resolve(), {"sha": TIP, "operation": "release"})
        payload = event()
        payload["after"] = OLD
        self.assertEqual(self.resolve(payload=payload, sha=OLD), {"sha": OLD, "operation": "release"})
        with self.assertRaisesRegex(ValueError, "Push SHA"):
            self.resolve(payload=payload)

    def test_pr_merge_is_check_only_even_when_input_claims_release(self):
        payload = event()
        payload["pull_request"] = {"base": {"ref": "main", "repo": {"full_name": candidate.REPOSITORY}},
                                   "head": {"repo": {"full_name": "outsider/fork"}}}
        payload["inputs"] = {"operation": "release", "sha": TIP}
        self.assertEqual(self.resolve("pull_request", payload, "refs/pull/123/merge"),
                         {"sha": TIP, "operation": "check"})
        with self.assertRaises(ValueError):
            self.resolve("pull_request", payload, "refs/heads/main")
        payload["pull_request"]["base"]["repo"]["full_name"] = "outsider/fork"
        with self.assertRaises(ValueError):
            self.resolve("pull_request", payload, "refs/pull/123/merge")

    def test_foreign_repository_default_branch_and_non_main_events_fail(self):
        with self.assertRaises(ValueError):
            self.resolve(repository="outsider/fork")
        for field, value in (("full_name", "outsider/fork"), ("default_branch", "dev")):
            payload = event()
            payload["repository"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.resolve(payload=payload)
        for name in ("push", "workflow_dispatch"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "from main"):
                self.resolve(name, self.dispatch(), "refs/heads/untrusted")

    def test_deleted_or_other_branch_push_and_foreign_commit_fail(self):
        for field, value in (("ref", "refs/heads/dev"), ("deleted", True)):
            payload = event()
            payload[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.resolve(payload=payload)
        payload = event()
        payload["after"] = FOREIGN
        with self.assertRaisesRegex(ValueError, "history"):
            self.resolve(payload=payload, sha=FOREIGN)

    def test_manual_release_retry_rechecks_current_tip(self):
        self.assertEqual(self.resolve("workflow_dispatch", self.dispatch()), {"sha": TIP, "operation": "release"})
        with self.assertRaisesRegex(ValueError, "current main tip"):
            self.resolve("workflow_dispatch", self.dispatch(sha=OLD))

    def test_rollback_allows_main_ancestor_and_rejects_orphan(self):
        self.assertEqual(self.resolve("workflow_dispatch", self.dispatch("rollback", OLD)),
                         {"sha": OLD, "operation": "rollback"})
        with self.assertRaisesRegex(ValueError, "history"):
            self.resolve("workflow_dispatch", self.dispatch("rollback", FOREIGN))

    def test_short_sha_uppercase_newline_and_command_injection_fail(self):
        for sha in ("abc123", TIP.upper(), TIP + "\n", TIP + "; id", None, 1):
            with self.subTest(sha=sha), self.assertRaises(ValueError):
                self.resolve("workflow_dispatch", self.dispatch(sha=sha))
        for operation in ("retry", "release; id", "rollback\nrelease", None):
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                self.resolve("workflow_dispatch", self.dispatch(operation))

    def test_unsupported_events_fail(self):
        for name in ("pull_request_target", "workflow_run", "schedule", "repository_dispatch"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.resolve(name)

    def test_cli_checks_real_git_ancestry_and_emits_only_valid_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
            def commit(message):
                subprocess.run(["git", "-c", "user.name=CI", "-c", "user.email=ci@example.test",
                                "commit", "-q", "--allow-empty", "-m", message], cwd=root, check=True)
                return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
            old = commit("old")
            tip = commit("tip")
            subprocess.run(["git", "update-ref", "refs/remotes/origin/main", tip], cwd=root, check=True)
            payload = self.dispatch("rollback", old)
            payload["after"] = tip
            event_file = root / "event.json"
            output_file = root / "output.txt"
            event_file.write_text(json.dumps(payload))
            environment = {**os.environ, "GITHUB_EVENT_PATH": str(event_file), "GITHUB_OUTPUT": str(output_file),
                           "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": candidate.REPOSITORY,
                           "GITHUB_REF": candidate.MAIN_REF, "GITHUB_SHA": tip}
            completed = subprocess.run([os.sys.executable, str(SCRIPT)], cwd=root, env=environment,
                                       capture_output=True, text=True)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(output_file.read_text(), f"sha={old}\noperation=rollback\n")
            payload["inputs"] = {"operation": "release", "sha": old}
            event_file.write_text(json.dumps(payload))
            output_file.unlink()
            completed = subprocess.run([os.sys.executable, str(SCRIPT)], cwd=root, env=environment,
                                       capture_output=True, text=True)
            self.assertNotEqual(completed.returncode, 0)
            self.assertFalse(output_file.exists())


if __name__ == "__main__":
    unittest.main()
