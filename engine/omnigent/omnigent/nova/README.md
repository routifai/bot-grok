# Nova

Nova is a personal AI built on Omnigent. Omnigent runs the sessions (agent loop,
harnesses, tools, policies, sandboxes, sharing); this package adds what a personal
assistant needs on top: what it remembers, what it's working toward, what it asks
you, and what it tells you while you're away.

Everything here runs in the Omnigent server process and stores its data in the
Omnigent database. There is no separate Nova backend.

## Primitives

Each primitive is one folder with one job. Read its README first.

| Primitive   | Owns                                                        | Tables prefix        |
| ----------- | ----------------------------------------------------------- | -------------------- |
| `memory/`   | Notes Nova keeps about the person and for itself, with revisions | `nova_memory_`   |
| `episodes/` | A dated record of each finished task, and recall of past ones | `nova_episodes`     |
| `goals/`    | Goals, their plan of tasks, proposals and check-ins          | `nova_goal`          |
| `asks/`     | Questions and approvals waiting on the person, durably       | `nova_asks`          |
| `feed/`     | Feed posts, followed topics and ideas                        | `nova_feed_`         |
| `skills/`   | Skills Nova learned or was taught, and pending save offers   | `nova_skill`         |
| `context/`  | Builds what the model should know on each turn               | none                 |

`_shared/` holds the few types every primitive uses: who is asking (`NovaActor`),
where a session sits (`Scope`), a context section, and text helpers.

## Folder layout (every primitive)

```
<primitive>/
  README.md             what it owns, its public API, its tables
  __init__.py           the public surface: the only module other code may import
  entities.py           frozen dataclasses: the domain types
  tables.py             SQLAlchemy models on OmnigentBase
  store.py              the store interface (ABC)
  sqlalchemy_store.py   the store implementation
  service.py            domain logic; pure functions where possible
  routes.py             create_router(deps: NovaDeps) -> APIRouter   (optional)
  tools.py              TOOLS: {name: factory} Omnigent built-in tools (optional)
  context.py            context_section(request) -> ContextSection | None (optional)
```

Tests live in `tests/nova/<primitive>/`. Migrations live in the normal Omnigent
chain (`omnigent/db/migrations/versions/nova_*`).

## Rules

1. **One way in.** Import another primitive only through its package
   (`from omnigent.nova.memory import ...`), never its internal modules.
2. **Context is pulled, not pushed.** A primitive contributes to the model's context
   by exposing `context_section` in `context.py`. `context/` collects them; it never
   reaches into another primitive's tables.
3. **Private stays private.** Every query is scoped by `user_id` and
   `workspace_id`. Anything that reads the person's private data returns nothing
   when `scope` is not `Scope.PRIVATE`.
4. **Follow Omnigent's database rules** (`docs/DATABASE_BEST_PRACTICES.md`): 32-char
   hex ids, epoch-second timestamps, `workspace_id` leading every primary key, no
   database foreign keys.
5. **Small files, plain names.** A module does one thing. Comments say why, briefly.
   No abbreviations in public names.
6. **Registration is automatic.** `_registry.py` finds each primitive's
   `routes.create_router`, `tools.TOOLS` and `context.context_section`. Adding a
   primitive never means editing another one.
