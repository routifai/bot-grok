# The engine owns the host; Superchat only relays

Turns now run on the Omnigent engine, inside the Muse's host. Superchat and the engine each kept their own record of which container that host was, and the records drifted: the engine's sandbox provider re-provisioned the container, Superchat's `host.providerRef` kept the old id, and the idle jobs all acted on a container that no longer existed. We decided the engine owns the host end to end: which container it is and whether its runner is ready. Superchat's API asks the engine and holds no host state of its own. The sandbox supervisor stays as the plain Docker backend behind the engine's provider, and only the engine calls it.

## Considered options

- **Superchat owns the host, the engine borrows it.** Rejected: everything is moving under the engine, and keeping Superchat's record authoritative would mean the engine reports container changes back into Superchat's database, which is exactly the coupling that drifted.
- **Split: engine runs turns, Superchat keeps the host record and syncs from the engine's host record.** Rejected: two records of one thing is the bug we are fixing.

## Consequences

- The host stays on; nothing stops it when idle. The Pi-era idle-sleep job goes away.
