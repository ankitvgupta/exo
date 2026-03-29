---
name: gh-local
description: Run GitHub Actions CI workflows locally using nektos/act in Docker. Use when testing CI before pushing or debugging workflow failures.
disable-model-invocation: true
argument-hint: "[job-name] [workflow-file]"
---

Run GitHub Actions CI workflows locally using [nektos/act](https://github.com/nektos/act) in Docker.

## Arguments

The user may specify:
- A specific job to run (e.g., "test", "typecheck"). If not specified, run all jobs.
- A specific workflow file. If not specified, use `.github/workflows/ci.yml`.

## Instructions

1. **Verify prerequisites**:
   - Check that `act` is installed: `which act`. If not, tell the user to install it with `brew install act`.
   - Check that Docker is running: `docker info`. If not, tell the user to start Docker Desktop.

2. **Run the workflow**:
   - Use the `catthehacker/ubuntu:act-latest` image (small, ~2GB, cached after first pull).
   - Always use `--container-architecture linux/amd64` for consistent behavior on Apple Silicon.
   - If a specific job was requested: `act pull_request -j <job> --container-architecture linux/amd64 -P ubuntu-latest=catthehacker/ubuntu:act-latest`
   - If running all jobs: `act pull_request --container-architecture linux/amd64 -P ubuntu-latest=catthehacker/ubuntu:act-latest`
   - Run the command in the background using the `run_in_background` parameter and set `timeout` to 600000 (10 minutes).

3. **Monitor progress**:
   - Check on the output periodically (every 60-90 seconds) using `tail -50` on the output file.
   - Report progress to the user as steps complete (e.g., "npm ci done", "build complete", "tests running").

4. **Report results**:
   - When finished, show the user which steps passed/failed.
   - If a step failed, show the relevant error output.
   - Compare with the real CI if there are discrepancies (act doesn't support all GitHub Actions features like artifact uploads).

## Notes

- The `catthehacker/ubuntu:act-latest` image is minimal. If the workflow needs tools not in the base image (like browsers), they'll be installed via the workflow's own steps (e.g., `npx playwright install-deps`).
- `act` doesn't support `actions/upload-artifact` natively — those steps will fail but can be ignored.
- Environment variables set in the workflow YAML are respected by `act`.
