import json
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[1] / "workflows/tempo-ci.yml"


class WorkflowBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text()
        cls.ci, cls.deploy = cls.text.split("\n  deploy:\n", 1)
        cls.ssh_script = textwrap.dedent(cls.deploy.split("        run: |\n", 1)[1])

    def test_required_check_cannot_be_skipped_by_a_failed_predecessor(self):
        self.assertIn("    name: Offline checks\n", self.ci)
        self.assertNotIn("\n    needs:", self.ci)
        self.assertNotIn("\n    if:", self.ci)
        self.assertIn("python3 .github/scripts/resolve-candidate.py", self.ci)

    def test_production_credentials_are_absent_from_ci(self):
        self.assertNotIn("secrets.", self.ci)
        self.assertNotIn("production\n", self.ci)
        self.assertIn("permissions:\n  contents: read", self.ci)
        self.assertNotIn("pull_request_target:", self.text)
        self.assertNotIn("workflow_run:", self.text)

    def test_rollback_checks_current_guards_and_docs_before_switching_to_historical_source(self):
        switch = self.ci.index("Checkout the validated historical candidate")
        for command in ("python3 -m unittest discover -s .github/test",
                        "python3 -m unittest discover -s deploy/tempo-vps/cicd/test",
                        "node scripts/check-doc-links.mjs"):
            self.assertLess(self.ci.index(command), switch)
        self.assertIn("npm run docs:check --if-present", self.ci[switch:])
        self.assertIn("SPECIALIST_LIVE: '0'", self.ci)
        self.assertIn("ARENA_PLAY_TEST_URL: ''", self.ci)

    def test_deploy_requires_successful_ci_main_and_canonical_repository(self):
        for check in ("needs: ci", "needs.ci.result == 'success'", "github.ref == 'refs/heads/main'",
                      "github.repository == 'Kris77z/tabby-tempo'", "github.event_name == 'push'",
                      "github.event_name == 'workflow_dispatch'", "name: production",
                      "cancel-in-progress: false", "permissions: {}"):
            self.assertIn(check, self.deploy)
        self.assertNotIn("uses:", self.deploy)
        self.assertNotIn("checkout@", self.deploy)
        self.assertNotIn("upload-artifact@", self.text)
        self.assertNotIn("download-artifact@", self.text)

    def test_action_references_are_full_verified_pins(self):
        expected = {"actions/checkout": "fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
                    "actions/setup-node": "a0853c24544627f65ddf259abe73b1d18a591444",
                    "foundry-rs/foundry-toolchain": "908c540300062bd5a7e473851cdb4282204cee09"}
        for action, revision in re.findall(r"uses: ([^@\s]+)@([^\s]+)", self.text):
            self.assertEqual(revision, expected[action])
            self.assertRegex(revision, r"^[0-9a-f]{40}$")

    def test_offline_script_group_is_serial_and_covers_retained_new_launchers(self):
        group = self.ci.split("- name: Run offline Tempo runtime, migration, RPC and journal checks", 1)[1].split("      - name:", 1)[0]
        expected = {"tempo-hosted-runtime", "tempo-runtime-upgrade", "tempo-vps-migrate", "tempo-rpc", "tempo-rpc-pacing", "journal-chain", "external-stack"}
        self.assertEqual(set(re.findall(r"scripts/test/([a-z0-9-]+)\.test\.ts", group)), expected)
        self.assertIn("--test-concurrency=1", group)
        self.assertNotIn("prepare-external-provider", group)
        self.assertIn("sudo apt-get install --no-install-recommends -y bubblewrap socat apparmor apparmor-profiles", self.ci)
        self.assertIn("if [[ -f scripts/test/external-stack.test.ts ]]; then", group)

    def test_unprivileged_namespace_gate_precedes_historical_checkout_and_long_suites(self):
        prepare = self.ci.index("Prepare the hosted runner's restricted Linux namespace fixture")
        gate = self.ci.index("Test current Linux namespace boundary before long suites")
        historical = self.ci.index("Checkout the validated historical candidate")
        self.assertLess(prepare, gate)
        self.assertLess(gate, historical)
        self.assertLess(gate, self.ci.index("Build and test Solidity locally"))
        self.assertLess(gate, self.ci.index("Run the complete offline workspace suite"))
        block = self.ci[gate:historical]
        self.assertIn('test "$(id -u)" -ne 0', block)
        self.assertIn("node --import tsx --test --test-concurrency=1 scripts/test/linux-magpie.test.ts", block)
        self.assertIn("exit 1", block)
        self.assertNotIn("sudo node", block)
        self.assertNotIn("continue-on-error", self.ci)
        self.assertIn("Install current workflow dependencies without production secrets", self.ci[:gate])
        self.assertIn("Install historical candidate dependencies for rollback checks", self.ci[historical:])

    def test_namespace_preparation_keeps_global_controls_and_restrictive_distro_child_policy(self):
        block = self.ci.split("Prepare the hosted runner's restricted Linux namespace fixture", 1)[1].split("      - name:", 1)[0]
        self.assertIn("profile=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict", block)
        self.assertIn('sudo apparmor_parser -Q "$profile"', block)
        self.assertIn('sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict', block)
        self.assertIn('sudo install -o root -g root -m 0644 "$profile"', block)
        self.assertIn('test "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)" = "$restriction"', block)
        for forbidden in ("sysctl -w", "sysctl --write", "systemctl stop apparmor", "aa-disable", "chmod u+s", "--share-net"):
            self.assertNotIn(forbidden, self.ci)

    def run_ssh(self, sha="a" * 40, operation="release", known_hosts="154.12.34.51 ssh-ed25519 synthetic"):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mock_bin = root / "bin"
            mock_bin.mkdir()
            log = root / "calls.jsonl"
            mock = "#!/usr/bin/env python3\nimport json, os, sys\nfrom pathlib import Path\n" \
                   "with Path(os.environ['MOCK_LOG']).open('a') as log:\n" \
                   "    log.write(json.dumps([Path(sys.argv[0]).name, *sys.argv[1:]]) + '\\n')\n"
            for name in ("ssh", "ssh-keygen"):
                file = mock_bin / name
                file.write_text(mock)
                file.chmod(0o755)
            environment = {**os.environ, "PATH": str(mock_bin) + os.pathsep + os.environ["PATH"],
                           "MOCK_LOG": str(log), "RUNNER_TEMP": str(root), "RELEASE_SHA": sha,
                           "RELEASE_OPERATION": operation, "TEMPO_DEPLOY_SSH_KEY": "synthetic-private-key",
                           "TEMPO_DEPLOY_KNOWN_HOSTS": known_hosts}
            result = subprocess.run(["bash", "-c", self.ssh_script], env=environment, capture_output=True, text=True)
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            leftovers = list(root.glob("tempo-deploy-ssh.*"))
            self.assertNotIn("synthetic-private-key", result.stdout + result.stderr)
            self.assertEqual(leftovers, [])
            return result, calls

    def test_ssh_uses_only_fixed_host_user_and_exact_forced_command(self):
        for operation in ("release", "rollback"):
            with self.subTest(operation=operation):
                result, calls = self.run_ssh(operation=operation)
                self.assertEqual(result.returncode, 0, result.stderr)
                ssh = [call for call in calls if call[0] == "ssh"]
                self.assertEqual(len(ssh), 1)
                self.assertEqual(ssh[0][-2:], ["tabby-tempo-deploy@154.12.34.51", f"{operation} {'a' * 40}"])
                for option in ("StrictHostKeyChecking=yes", "UpdateHostKeys=no", "IdentitiesOnly=yes",
                               "BatchMode=yes", "GlobalKnownHostsFile=/dev/null", "ForwardAgent=no",
                               "PasswordAuthentication=no", "ClearAllForwardings=yes"):
                    self.assertIn(option, ssh[0])
                self.assertNotIn("ssh-keyscan", self.ssh_script)

    def test_invalid_command_sha_or_missing_host_key_never_calls_ssh(self):
        for args in ({"sha": "main"}, {"sha": "a" * 40 + "; id"}, {"operation": "release; id"},
                     {"known_hosts": ""}):
            with self.subTest(args=args):
                result, calls = self.run_ssh(**args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
