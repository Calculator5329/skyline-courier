# Art direction — from Ethan's reference images (2026-07-25)

Ethan supplied three reference images. They are the authority for how this
game should look, and they substantially revise the earlier "pale cream
porcelain, sunny midday" reading carried over from Clockwork Garden.

Written down here because the images live in a chat log and this repo does
not (and will not) contain image files.

## The one-line version

**A clockwork sky-garden archipelago floating above a sea of golden sunset
clouds** — a lush steampunk botanical observatory, rendered like a polished
stylized 3D animated feature. Warm, saturated, luminous, inviting.

## What the references show

### World structure
- Islands **float in open sky**, above and among a bright cloud deck. There is
  no ground plane and no city skyline. The horizon is cloud.
- Islands are **drum- and plateau-shaped**: flat built tops, chunky rounded
  boulder undersides, vines trailing off the bottom edges.
- Scattered islands recede into golden haze at many distances — near, mid,
  far, and tiny specks. Depth is the headline effect.
- Waterfalls spill off island edges into cloud.

### Lighting
- **Golden hour.** Low warm sun, strong rim and backlight, amber wash over
  everything.
- **Cool, green-tinted shadows** against that warm key. The warm/cool split is
  the single most defining characteristic.
- Bright warm **upward bounce off the cloud tops** — much stronger than a
  normal earth bounce, so undersides are lit, not black.
- Glowing motes / fireflies throughout.

### Materials
- **Warm sandstone and terracotta masonry** — carved blocks, arches,
  balustrades, columns, stairs, circular drum platforms. Sandy peach and ochre.
  Not grey, and not the pale cream we currently have.
- **Brass everywhere, and ornate**: gears, ship's wheels, armillary spheres,
  telescopes, orrery rings, pipework, studded bands, domed roofs. Polished
  golden highs with darker recesses and verdigris in the crevices. Brass is
  the signature material of the world.
- **Lush saturated moss** in thick caps sitting *on top of* stone with a soft
  irregular overhanging lip.
- **Heavy vegetation**: hanging ivy and vines, dark cypress trees, small
  orange/red/white flowers, leafy canopies. Vegetation is a primary element,
  not a garnish.
- Teal/verdigris glass accents in domes and portholes.

## What this changes for us

| Current | Target |
|---|---|
| Pale cream porcelain | Warm sandstone / ochre masonry |
| Grey stone towers on a ground plane | Floating islands in a cloud sea |
| Flat sunny midday sky | Low golden-hour sun, sunset gradient |
| Neutral grey shadows | Cool green-tinted shadows |
| Flat gold brass | Ornate machined brass — rings, rivets, verdigris |
| Uniform speckled moss | Thick clumped moss caps with overhanging lips |
| Dust wedge at junctions | **Moss** wedge creeping up walls |
| Bare boxes | Drums, arches, gears, vines, cypress |

## The constraint that does not change

Still **zero image files**. The reference look is achieved with shader
technique and generated geometry, exactly as the parked Clockwork Garden's
failure taught us. The reference project Ethan shared reaches comparable
quality with no assets at all.

## The collision caveat, stated honestly

Collision is axis-aligned boxes (`src/collision.js`), deliberately, because
predictable wall-runs matter more than general geometry. Drum-shaped visual
platforms therefore need their **footprint to match their box collider**, not
be inscribed inside it — otherwise we reintroduce Clockwork Garden's exact
bug of a surface you can see but not stand on. Prefer chamfered/rounded-square
prisms whose extent equals the collider over true cylinders, and accept a
small non-walkable overhang at the corners rather than the reverse.
