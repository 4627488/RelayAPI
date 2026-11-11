"""Exercise the real deployment script with isolated Docker/HTTP/lock commands."""

import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "deploy/deploy-relayapi.sh"
OLD = "ghcr.io/4627488/relayapi:sha-aaaaaaa"
TARGET = "ghcr.io/4627488/relayapi:sha-bbbbbbb"


def mock_command(command, args):
    state_file = Path(os.environ["DEPLOY_TEST_STATE"])
    state = json.loads(state_file.read_text())
    state["calls"].append([command, *args])
    status = 0
    if command == "flock":
        status = int(state.get("locked", False))
    elif command == "curl":
        status = int(state.get("unhealthy", False) and state["running"] == TARGET)
    elif command == "docker":
        if args[0] == "pull":
            status = int(state.get("pull_failure", False))
        elif args[0] == "inspect":
            print(state["running"] if ".Config.Image" in args[-1] else state["running_id"])
        elif args[:2] == ["image", "inspect"]:
            print("target-id")
        elif args[0] == "compose":
            operation = args[3]
            if operation == "ps" and "-q" in args:
                print("preview-service-container")
            elif operation == "up":
                image = re.search(r"^    image: (.+)$", Path(args[2]).read_text(), re.M)[1]
                state["restarts"].append(image)
                status = int(state.get("startup_failure", False) and image == TARGET)
                if not status:
                    state["running"] = image
                    state["running_id"] = "target-id" if image == TARGET else "old-id"
    state_file.write_text(json.dumps(state))
    return status


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="relay-deploy-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.compose = self.root / "compose.yml"
        self.compose.write_text(f"services:\n  relayapi:\n    image: {OLD}\n")
        self.state_file = self.root / "state.json"
        self.state = {"running": OLD, "running_id": "old-id", "calls": [], "restarts": []}
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for command in ("docker", "curl", "flock", "sleep"):
            wrapper = bin_dir / command
            wrapper.write_text(
                "#!/bin/sh\nexec "
                + shlex.join([Path(sys.executable).as_posix(), Path(__file__).resolve().as_posix(), "--mock", command])
                + ' "$@"\n'
            )
            wrapper.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
            "DEPLOY_TEST_STATE": str(self.state_file),
            "RELAYAPI_DEPLOY_DIR": self.root.as_posix(),
        }

    def deploy(self, image=TARGET):
        self.state_file.write_text(json.dumps(self.state))
        result = subprocess.run(
            [os.environ.get("BASH_BIN", "bash"), SCRIPT.as_posix(), image],
            env=self.env, capture_output=True, text=True, timeout=60,
        )
        self.state = json.loads(self.state_file.read_text())
        return result

    def test_success_selects_exact_image_and_discovers_compose_container(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state["restarts"], [TARGET])
        self.assertIn(TARGET, self.compose.read_text())
        self.assertIn("Image pull completed in", result.stdout)
        inspections = [call for call in self.state["calls"] if call[:2] == ["docker", "inspect"]]
        self.assertTrue(inspections)
        self.assertTrue(all(call[2] == "preview-service-container" for call in inspections))

    def test_healthy_same_image_does_not_restart(self):
        self.state.update(running=TARGET, running_id="target-id")
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state["restarts"], [])
        self.assertIn(TARGET, self.compose.read_text())

    def test_pull_failure_preserves_old_configuration_and_container(self):
        self.state["pull_failure"] = True
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertIn(OLD, self.compose.read_text())
        self.assertEqual(self.state["restarts"], [])

    def test_readiness_failure_rolls_back(self):
        self.state["unhealthy"] = True
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(self.state["restarts"], [TARGET, OLD])
        self.assertEqual(self.state["running"], OLD)
        self.assertIn(OLD, self.compose.read_text())

    def test_startup_failure_rolls_back(self):
        self.state["startup_failure"] = True
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(self.state["restarts"], [TARGET, OLD])
        self.assertIn(OLD, self.compose.read_text())

    def test_busy_lock_leaves_deployment_untouched(self):
        self.state["locked"] = True
        self.assertEqual(self.deploy().returncode, 3)
        self.assertEqual(self.state["calls"], [["flock", "-n", "9"]])

    def test_invalid_image_is_rejected_before_external_commands(self):
        self.assertEqual(self.deploy("ghcr.io/4627488/relayapi:latest").returncode, 2)
        self.assertEqual(self.state["calls"], [])


if __name__ == "__main__":
    if sys.argv[1:2] == ["--mock"]:
        sys.exit(mock_command(sys.argv[2], sys.argv[3:]))
    unittest.main()
