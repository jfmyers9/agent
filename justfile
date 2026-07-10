set shell := ["sh", "-eu", "-c"]

default:
	@just --list

check:
	bun run check

test:
	bun run test
