#!/usr/bin/env python3
"""Resolve an exact CI candidate without production credentials or remote execution."""

import json
import os
import re
import subprocess
from pathlib import Path

REPOSITORY = "Kris77z/tabby-tempo"
MAIN_REF = "refs/heads/main"
SHA = re.compile(r"[0-9a-f]{40}\Z")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def exact_sha(value):
    require(isinstance(value, str) and SHA.fullmatch(value), "Expected a full lowercase 40-character commit SHA")
    return value


def resolve(event_name, event, repository, ref, event_sha, main_sha, is_ancestor):
    """is_ancestor also verifies the candidate is a commit in the fetched repository."""
    require(repository == REPOSITORY, "Unexpected workflow repository")
    source = event.get("repository", {})
    require(source.get("full_name") == REPOSITORY, "Unexpected event repository")
    require(source.get("default_branch") == "main", "The default branch must be main")
    event_sha = exact_sha(event_sha)
    main_sha = exact_sha(main_sha)

    if event_name == "pull_request":
        pull = event.get("pull_request", {})
        base = pull.get("base", {})
        require(base.get("ref") == "main" and base.get("repo", {}).get("full_name") == REPOSITORY,
                "PR must target this repository's main branch")
        require(re.fullmatch(r"refs/pull/[1-9][0-9]*/merge", ref or ""), "Expected a PR merge ref")
        return {"sha": event_sha, "operation": "check"}

    require(ref == MAIN_REF, "Production requests must run the workflow from main")
    if event_name == "push":
        require(event.get("ref") == MAIN_REF and event.get("deleted") is False, "Expected a non-deleted main push")
        require(event.get("after") == event_sha, "Push SHA does not match the workflow SHA")
        require(is_ancestor(event_sha, main_sha), "Pushed commit is outside current main history")
        return {"sha": event_sha, "operation": "release"}

    require(event_name == "workflow_dispatch", "Unsupported workflow event")
    inputs = event.get("inputs", {})
    operation = inputs.get("operation")
    require(operation in ("release", "rollback"), "Expected release or rollback")
    target = exact_sha(inputs.get("sha"))
    require(is_ancestor(target, main_sha), "Requested commit is outside current main history")
    if operation == "release":
        require(target == main_sha, "Release retry must target the current main tip")
    # The root-owned VPS entry independently requires a previously successful release for rollback.
    return {"sha": target, "operation": operation}


def git(*args):
    return subprocess.run(["git", *args], check=True, text=True, capture_output=True).stdout.strip()


def ancestor(candidate, main):
    if subprocess.run(["git", "cat-file", "-e", candidate + "^{commit}"], capture_output=True).returncode:
        return False
    return subprocess.run(["git", "merge-base", "--is-ancestor", candidate, main], capture_output=True).returncode == 0


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    result = resolve(os.environ["GITHUB_EVENT_NAME"], event, os.environ["GITHUB_REPOSITORY"],
                     os.environ["GITHUB_REF"], os.environ["GITHUB_SHA"],
                     git("rev-parse", "refs/remotes/origin/main"), ancestor)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for name, value in result.items():
            output.write(f"{name}={value}\n")
    print(f"Validated {result['operation']} candidate {result['sha']}")


if __name__ == "__main__":
    main()
