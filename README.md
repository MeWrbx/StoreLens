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
| `ROBLOX_API_BASE` | Open Cloud | override for local testing |

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
```

All of them take optional `universeId` and `scope`.

## TODO

- Ordered DataStores (the ones behind leaderboards)
- Export a whole data store to a JSON file
- Diff two versions side by side
- Switch between universes without editing `.env`

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
