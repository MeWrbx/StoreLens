# StoreLens

A small local dashboard for reading and editing Roblox DataStores. Runs on your
machine, talks to the Open Cloud API, no Studio session required.

![screenshot](docs/screenshot.png)

## Why

Debugging save systems used to mean opening Studio, writing a throwaway script to
read one key, squinting at the Output window, then writing another script to fix
the value. That loop is slow and it's easy to write garbage back by accident.

This does the same thing in a browser tab: pick a data store, pick a key, look at
the JSON, fix it, save. Version history is right there if you need to roll back.

## Setup

Node 20 or newer. There are no dependencies, so there's nothing to install.

```
git clone https://github.com/<you>/StoreLens.git
cd StoreLens
cp .env.example .env
npm start
```

Open http://localhost:3000.

### Getting an API key

Go to [create.roblox.com/dashboard/credentials](https://create.roblox.com/dashboard/credentials)
and create a key with the `universe-datastores` system enabled for your universe. You need `universe-datastores.objects:read` and `universe-datastores.objects:list` to browse entries within a data store, **plus `universe-datastores.control:list` to list the data stores themselves** (easy to miss - without it you get an "Insufficient scope" error on load). Add `:create`/`:update`/`:delete` under `objects` if you want to edit or remove entries. Under security you have to allow at least your own IP.

Put the key in `.env` as `ROBLOX_API_KEY`. Your universe id is the number in the
Creator Dashboard URL for the experience (not the place id) - `game.GameId` in
Studio gives you the same thing.

## Config

| var | default | |
|---|---|---|
| `ROBLOX_API_KEY` | - | required |
| `ROBLOX_UNIVERSE_ID` | - | loaded on startup if set |
| `PORT` | 3000 | |
| `HOST` | 127.0.0.1 | don't bind this to 0.0.0.0 |
| `READ_ONLY` | false | `true` blocks writes and deletes |
| `ROBLOX_TIMEOUT_MS` | 15000 | request deadline, prevents a hung dashboard |
| `ROBLOX_API_BASE` | Open Cloud | override for local testing |
| `ROBLOX_ORDERED_API_BASE` | Open Cloud | same, for ordered stores |

## A few things worth knowing

The API key stays in the Node process. It's never sent to the browser, so nothing
running on the page can read it.

Saves use `matchVersion`. The version you loaded gets sent back with the write, and
Open Cloud rejects it with a 412 if the key changed in the meantime. If a player
saved while you had the editor open, your write fails instead of wiping their
progress. Reload and redo the edit.

Deletes are soft - old versions stick around for about 30 days and you can pull
them back from the version list.

There's no auth on this thing at all, which is why it binds to localhost. Don't
put it on a server.

Because it binds to localhost, any website you have open in the same browser could
otherwise talk to it. The server therefore rejects requests carrying a foreign
`Origin` or `Sec-Fetch-Site: cross-site`, and requires `Content-Type: application/json`
on writes. Keep that guard in place if you fork this.

If you're touching a live game, run with `READ_ONLY=true` and only turn it off for
the minute you actually need to fix something.

## HTTP API

The frontend is just a client for this, so you can script against it directly.

```
GET    /api/health
GET    /api/datastores?prefix=&cursor=
GET    /api/keys?datastore=&prefix=&cursor=
GET    /api/entry?datastore=&key=
POST   /api/entry              {datastore, key, value, matchVersion}
DELETE /api/entry?datastore=&key=
GET    /api/versions?datastore=&key=
GET    /api/version?datastore=&key=&versionId=
GET    /api/export?datastore=&prefix=&max=
GET    /api/search?datastore=&prefix=&contains=&caseSensitive=&max=
POST   /api/import           {datastore, payload, mode, dryRun}

GET    /api/ordered/entries?store=&limit=&pageToken=&ascending=
GET    /api/ordered/entry?store=&entry=
POST   /api/ordered/entry     {store, entry, value}      set
POST   /api/ordered/entry     {store, entry, increment}  atomic add
DELETE /api/ordered/entry?store=&entry=
```

All of them take optional `universeId` and `scope`.

## Ordered data stores

Switch the dropdown in the header from Standard to Ordered. These hold integers
only and stay sorted, which is what leaderboards are built on. There's no API to
list them, so type the store name exactly and press Enter. Entries come back
highest first; you can set a value outright or use `+1`/`-1`, which goes through
Open Cloud's atomic increment so two writers can't clobber each other.

## Export

The Export button in the Keys column walks every key in the selected data store
and downloads them as one JSON file. The key prefix filter applies, so you can
export just `Player_` if that's all you need. It's capped at 2000 entries by
default (`max` on the endpoint, hard limit 20000) to keep a stray click from
eating your universe's rate limit. Keys that fail to read are listed under
`failures` instead of killing the run.

## Import

The Import button takes a file you exported earlier and writes it back. It runs a
dry pass first, tells you how many keys are new and how many already exist, and
lets you choose: overwrite everything, or only create the missing ones. Then it
asks once more before touching anything. Blocked entirely in read-only mode.

The file can be a whole export or just its `entries` array. Limit is 5000 rows
per file, and writes go one at a time on purpose - this touches live player saves.

## Finding a key by its contents

Open Cloud can only filter by key prefix, so the "value contains" box reads the
entries and matches locally. That means it costs the same as an export and is
capped the same way, but it answers questions the key list can't: which saves
still have the old `tutorialStep` field, who owns the duped sword, and so on.
Combine it with the key prefix to narrow the scan first.

## Comparing versions

Tick two rows in the version history and hit Compare selected for a side by side
diff. Useful for "what did this player's save look like before the patch".

## TODO

- Scheduled backups instead of a manual export click
- Undo for an import, using the versions it replaced

PRs welcome.

## Dev

```
npm run dev    # node --watch
npm test
npm run lint
```

Tests use `node:test`. To poke at the UI without a real universe, point
`ROBLOX_API_BASE` at a local mock server.

## Contact

Found a bug or something's broken? Reach out on Discord: **officialacestar**

## License

MIT
