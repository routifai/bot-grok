# The engine owns the Computer; Superchat only relays

Turns now run on the Omnigent engine, inside the Muse's Computer. Superchat and the engine each kept their own record of which container that Computer was, and the records drifted: the engine's sandbox provider re-provisioned the container, Superchat's `Computer.providerRef` kept the old id, and the idle jobs all acted on a container that no longer existed. We decided the engine owns the Computer end to end: which container it is and whether its runner is ready. Superchat's API asks the engine and holds no Computer state of its own. (The person no longer watches or takes over the Computer's screen; this fork has no live screen.) The sandbox supervisor stays as the plain Docker backend behind the engine's provider, and only the engine calls it.

## Considered options

- **Superchat owns the Computer, the engine borrows it.** Rejected: everything is moving under the engine, and keeping Superchat's record authoritative would mean the engine reports container changes back into Superchat's database, which is exactly the coupling that drifted.
- **Split: engine runs turns, Superchat keeps the Computer record and syncs from the engine's host record.** Rejected: two records of one thing is the bug we are fixing.

## Consequences

- The Computer stays on; nothing stops it when idle. The Pi-era idle-sleep job goes away.
- The Computer's local browser is one browser backend among others; the desktop-app browser remains the default.
