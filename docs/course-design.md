# Course design — the traversal envelope

Ethan, 2026-07-25: *"we will need a bigger course because of how OP the new
movement things are (dash/hook) but honestly they are so fun I want to keep
them like that and just improve graphics and expand course."*

**That is a design decision, not a bug report.** The movement set is
deliberately overpowered and stays that way. The course scales up to meet it.
Do not nerf dash, grapple, or the double jump to make an existing gap
challenging again — widen the gap.

This document exists so nobody has to guess how far the player can go. Every
number below is derived from `TUNING` in `src/player.js`. If you change a
tuning constant, **recompute this table**, because the whole course is built
against it.

## The numbers

From `TUNING`: `gravity 26`, `jumpSpeed 8.6`, `airJumpSpeed 7.6`,
`sprintSpeed 11`, `dashSpeed 21`, `dashTime 0.22`, `grappleRange 34`,
`grappleMinRange 5`, `climbSpeed 9.2`, `climbTime 0.5`.

### Horizontal reach, from a full sprint

| Technique | Airtime | Gap cleared | Use it for |
|---|---|---|---|
| Single jump | 0.66 s | **~7.3 m** | Rhythm gaps you take without thinking |
| + double jump | ~1.25 s | **~13.7 m** | The standard gap. Most of the course. |
| + dash | ~1.4 s | **~19 m** | Committed gaps. Costs a charge. |
| Grapple | — | **5–34 m** | Gated crossings. Needs an anchor. |

Derivation for the single jump: airtime `2 × 8.6 / 26 = 0.662 s`, times
`11 m/s` horizontal = `7.3 m`. The double jump resets vertical velocity to
`7.6` rather than adding to it, which buys another `0.58 s`.

### Vertical reach

| Technique | Height gained |
|---|---|
| Single jump | **1.42 m** (`8.6² / 2·26`) |
| + double jump | **~2.5 m** |
| Vertical wall-run | **~3.1 m** on top of entry height |
| Wall-jump chain | ~2.4 m per jump, unbounded while walls alternate |
| Grapple to a high anchor | Whatever the anchor is, up to 34 m away |

### The gap bands — use these, do not invent distances

- **0–7 m — free.** The player clears it at speed without a decision. Use for
  rhythm and flow, never as a challenge.
- **8–13 m — standard.** Needs the double jump. This is the default gap.
- **14–19 m — committed.** Needs double jump *and* dash. Spending the dash
  charge here means not having it for the next obstacle — that is the decision.
- **20–32 m — grapple-gated.** Only crossable with an anchor. **Placing a
  brass lantern is what makes a route exist.** This is now the primary level
  design lever.
- **>34 m — impassable.** Genuine boundary. Use to define the play space.

## Connect the horizon (Ethan, 2026-07-25, after playing the live build)

*"making all the islands and stuff in the horizon connected to the parkour
core. so it's a much bigger course because now the actions are so that we need
a lot more to explore."*

Right now the archipelago is a lie. Every island past the route is `decor()` —
visible, unreachable, and non-solid. The player can see a world they cannot
enter, which is the *inverse* of Clockwork Garden's bug and just as damaging:
it makes the whole space read as a painted backdrop the moment you try to go
there.

**The near and mid distance bands become real.** Solid, landable, and wired
into the route graph. Only the far band stays scenery, and it should be pushed
far enough out that no player ever gets close enough to test it.

### Grapple range is the connectivity graph

With `grappleRange 34`, an anchor defines a 34 m sphere of reachable space.
That makes lantern placement the literal topology of the level:

- Two islands within **~19 m** are connected by dash alone.
- Two islands within **34 m of a shared anchor** are connected by grapple.
- Anything further needs a stepping stone, and a stepping stone is a design
  decision about which way you want the player to travel.

Build the archipelago as a **graph first, geometry second**: place islands,
decide which pairs should connect, then place the lantern that makes each edge
exist. An island with no inbound edge is scenery whether you meant it or not.

### The fiction already solves the structure problem

An open archipelago needs a reason to go anywhere. **You are a courier** — so
deliveries are the structure. Drop points scattered across islands give the
space objectives without turning it into a collectathon, and they let the
player choose their own order and route, which is exactly what an overpowered
movement set wants.

That keeps the existing time-trial intact as *one* line through the world
rather than the only content.

### Rules for reachability

- Every solid island must be **reachable and escapable**. An island you can
  land on but not leave is a soft-lock, and with this much mobility players
  will find them.
- Verify reachability mechanically, not by eye: a script that walks the anchor
  graph and reports unreachable or dead-end islands should ship with this.
- Falling stays survivable — the cloud deck is below everything, so a fall
  returns you to the last checkpoint rather than ending anything.

## What "bigger" means concretely

The current course is ~230 m along a single straight +X axis, seven
checkpoints, roughly 45 seconds at pace. That is a tutorial, not a route.

**Targets for the expansion:**

1. **Length**: 900–1400 m of travelled route, 3–5 minutes at pace.
2. **Stop being a corridor.** The current course runs down one axis. The
   fiction is an *archipelago* — the route should turn, double back, and cross
   over itself so the player sees where they have been and where they are going.
   Seeing your own route from a new angle is most of what makes a traversal
   world feel like a place.
3. **Go vertical.** Currently the whole course lives between y=0 and y=8. The
   reference is islands at wildly different altitudes. Use a range of at least
   y=-20 to y=+90, with the finish genuinely high up.
4. **Branch.** At least three points where a fast, risky line and a safe,
   slower line diverge and rejoin. The fast line should be grapple- or
   dash-gated. This is where replay value comes from, and it is why a time
   trial is worth running twice.
5. **Anchor placement is level design.** Every brass lantern defines a
   reachable volume of 34 m radius. Place them to *author* routes: a lantern
   over a void creates a crossing; two in sequence create a chain; one high on
   a tower creates a shortcut for a player brave enough to aim mid-fall.
6. **Teach, then combine, then test.** The opening keeps its one-verb-at-a-time
   structure. The middle should demand combinations (grapple into a dash into
   a wall-run). The last third should assume complete fluency.

## Rules the expansion must not break

- Everything at walkable height is `solid()`. Never `decor()`. This is the bug
  that killed the predecessor project and it is the easiest one to reintroduce
  when placing a lot of scenery quickly.
- The route must remain completable end to end, and every checkpoint must
  remain reachable from the previous one **without** using dash or grapple —
  those are for the fast line, not the only line. A player who mistimes a dash
  and lands on the safe route should still be able to finish.
- Falling must always be recoverable: no checkpoint may leave the player in a
  position where the only option is to fall out of the world.
- Keep the frame budget. Everything merges per-material, but the archipelago
  scenery is already thousands of boxes — use the kit's `detail: 0|1|2` LOD
  for anything the player cannot reach, and `ghost: true` for distant copies.
