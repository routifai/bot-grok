# The engine owns the Computer; Nova only relays

Turns now run on the Omnigent engine, inside the Muse's Computer. Nova and the engine each kept their own record of which container that Computer was, and the records drifted: the engine's sandbox provider re-provisioned the container, Nova's `Computer.providerRef` kept the old id, and the screen, take over, and idle jobs all acted on a container that no longer existed. We decided the engine owns the Computer end to end: which container it is, its screen (a noVNC viewer link and token), and Take over (who is in control). Nova's API asks the engine and relays the screen stream through its existing same-origin proxy, holding no Computer state of its own. The sandbox supervisor stays as the plain Docker backend behind the engine's provider, and only the engine calls it.

## Considered options

- **Nova owns the Computer, the engine borrows it.** Rejected: everything is moving under the engine, and keeping Nova's record authoritative would mean the engine reports container changes back into Nova's database, which is exactly the coupling that drifted.
- **Split: engine runs turns, Nova keeps screen and control and syncs from the engine's host record.** Rejected: two records of one thing is the bug we are fixing.
- **Browser connects to the engine's screen stream directly.** Rejected: it exposes the engine to browsers and adds a second login path; the browser only ever talks to Nova.

## Consequences

- The Computer stays on; nothing stops it when idle. The Pi-era idle-sleep and control-expire jobs go away.
- The engine gains a screen/control capability on its sandbox providers. It stays generic: the desktop-app browser remains the default, and the Computer's local browser is one backend among others.
