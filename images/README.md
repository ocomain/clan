# Image organisation

All static image assets live under this directory, organised by purpose:

| Subfolder | Contents | Examples |
|---|---|---|
| `brand/` | Logos, favicons, OG/social meta images, official seals | `coat_of_arms.png`, `favicon-32x32.png`, `og-stpatricks.jpg` |
| `people/` | Portraits of named figures — Chief, Office, Privy Council, Patrons, named members appearing in editorial copy | `antoin_commane_bubble.jpg`, `fergus_burren.jpg` |
| `heritage/` | Places, landscapes, archaeological sites | `cahercommane_aerial.png`, `killone_abbey_lake.png`, `newhall_house.png` |
| `archive/` | Manuscripts, documents, heraldic plates, certificates, historical document scans | `clann_comain_odonovan_1843_irish.png`, `cotter_p83.png`, `the_commane_seal.png` |
| `editorial/` | Illustrative / creative artwork for editorial pieces (not photographs of real things) | `celtic_warriors.png`, `irish_kings_mosaic.png` |
| `events/` | Photography from Clan / Clans-of-Ireland events | `clans_dublin.jpg`, `clans_event_1.jpg` |

## When to add a file here vs. Supabase Storage

This directory is for **bounded, editorial content** that the Office curates:
- The set is O(100) files, not O(10,000+)
- Each file is a deliberate addition with a place in the site's editorial structure
- Version-controlled, deployed via the static-site CDN

**Member-generated content does not belong here.** Photos uploaded by members
(via the host-gathering form, future profile-photo flows, etc.) belong in
**Supabase Storage** under the `gathering-avatars` bucket (or future buckets
for other content types). Storage is the right tier because:
- Per-member partitioning is built-in
- File-size limits and content-type filtering can be enforced at bucket level
- GDPR right-to-erasure is a single DELETE
- The repo doesn't bloat as the clan grows

**Office-seeded photos** (rare cases where the Office adds a photo on behalf
of a member who hasn't uploaded one themselves) ideally also go to Supabase
Storage — but if seeded into this directory as a quick fix, the file should
migrate to Storage the next time the member edits via the host-form (which
naturally replaces the URL with a Storage one).

## Conventions

- Use `snake_case` filenames
- Append `_bubble` to small (≤400px) circular email-signature avatars to
  distinguish them from larger editorial portraits of the same person:
  `antoin_commane_bubble.jpg` (small, used in email signatures) vs.
  `antoin_dublin_formal.png` (large, used on the Privy Council page)
- Prefer JPEG for photographs, PNG for graphics with transparency or sharp
  edges (heraldry, manuscripts, screenshots)
- Compress aggressively before committing — most files here should be under
  500 KB. Use `image/optimize` Python tooling or a service like Squoosh
  before adding.

## When in doubt, ask

If a new image doesn't obviously fit one of the six subfolders, that's
usually a sign the folder structure needs revisiting rather than that the
file needs a new home at the root. Discuss before adding a seventh folder
or putting something at the root level.
