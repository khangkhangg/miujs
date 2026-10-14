# create-miu

Scaffold a new [MiuJS](https://github.com/khangkhangg/miujs) app.

```sh
npm create miu@latest my-app
# or
bun create miu my-app
# or
pnpm create miu my-app
```

Options (after `--` with npm):

| Flag | Default | |
| --- | --- | --- |
| `--template bun\|node\|workers` | `bun` | Runtime template |
| `--name <pkg>` | directory name | `name` in the new `package.json` |
| `--force` | | Scaffold into a non-empty directory |

```sh
npm create miu@latest my-worker -- --template workers
```

The directory defaults to `./miu-app`.

`create-miu` is a thin wrapper around `miu create` from the `miujs` package, so
`npx miujs create my-app` does the same thing.
