# Agent Note: CI prints gates and builds the image last

Status: implemented

## Problem

PR CI was red with three jobs and almost no signal. `gofmt -l` exiting 1
printed nothing. The web `Select` `items` type error failed frontend build
and the Docker image job in parallel, so the same TypeScript line looked like
two independent outages.

## Decision

Keep the same three jobs. Make the format gate print the file list and
`gofmt -d`. Run `pnpm typecheck` before lint/build. Build the image only
after backend and frontend succeed.

## Alternatives considered

**Leave the image job parallel.** Faster on green, but a frontend type error
burns a 30-minute runner and a second red check.

**Drop the image job from PRs.** Publish already builds on `main`. PR image
builds still catch Dockerfile/lockfile drift.

## Consequences

A format or typecheck failure is one red job with a file name. The image
job staying skipped means backend/frontend did not pass.
