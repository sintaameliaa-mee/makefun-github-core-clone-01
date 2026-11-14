# hamtaro-forge

A GitHub-compatible git forge in one Node 22 process, stdlib only, no dependencies,
no outside service. It serves the four surfaces the contest grades, all over one
in-memory store:

- **Git smart HTTP** — clone and push over `/{owner}/{repo}.git`, protocol v2 and v0,
  with real object storage (blobs, trees, commits, tags), pack read/write including
  OFS_DELTA and REF_DELTA, shallow fetch and deepen, ref updates with fast-forward
  checks, and sideband report-status.
- **REST v3** — `POST /api/v3/user/repos`, repos, branches, commits, contents
  (create/update/delete with blob-sha checks), git refs, labels, issues, comments and
  pull requests with file diffs and squash merge.
- **GraphQL v4** — `POST /api/graphql`: viewer, repository, issues, pull requests,
  mutations (create/close issue, create/merge pull request, add comment), node lookup
  by global id, and introspection.
- **MCP** — `POST /mcp`, JSON-RPC 2.0, both the modern `server/discover` revision
  (2026-07-28) and the legacy `initialize` handshake, with six tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`.

## Layout

| file | what it does |
| --- | --- |
| `main.ts` | the entry <-> env lifecycle (starter, unchanged) |
| `app.ts` | the HTTP server: auth, routing, body reading |
| `gitcore.ts` | pkt-lines, object hashing, commit/tree/tag parse/build, pack read/write |
| `diffutil.ts` | flat-tree diff and line diffs |
| `store.ts` | the in-memory forge: objects, refs, issues, PRs, labels, comments |
| `gitproto.ts` | info/refs, upload-pack (v2/v0), receive-pack |
| `rest.ts` | the REST v3 router and serializers |
| `graphql.ts` | the GraphQL parser and executor |
| `mcp.ts` | the MCP JSON-RPC endpoint and tools |
| `httputil.ts` | the shared handler-result shape |

## Running

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL`, and polls
`$MAKEFUN_ENV_URL/done` until the trial ends. Every API call needs
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; `/healthz` and the API root are public.

## Determinism

Nothing the server sends depends on the wall clock or on unseeded randomness:
commit and `created_at` timestamps come from a counter, global ids are
`base64url("<Type>:<key>")`, and the only random value is the per-request
`X-GitHub-Request-Id` header, which is never part of scored state. A replay of the
same trial therefore leaves the same state.
