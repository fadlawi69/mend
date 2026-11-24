# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fadlawi69/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fadlawi69/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it reads a patch in unified diff, SEARCH/REPLACE blocks, V4A patch format, or text-editor tool calls as JSON, and applies it to a tree of files — atomically (all files or none), with fuzzy line matching that tolerates wrong line numbers, drifted whitespace and indentation, CRLF files, and files without a final line break. Node 22, standard library only.

## Run it

```sh
node main.ts [options] [PATCH]
```

Practice checks (100 public checks, all passing):

```sh
node check.ts ../program/generator/practice.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=8qf5n112&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
